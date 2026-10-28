using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cats.DesktopControl.Windows;

internal sealed class HelperException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// SPEC-133 R7: one JSON request per stdin line, one JSON response per stdout line, protocol 1.
/// Phase A ops only observe; none of them sends input to another window.
/// </summary>
internal static class Program
{
    private const int Protocol = 1;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private static Exclusions? _exclusions;
    private static Apps? _apps;

    private static async Task<int> Main()
    {
        var dpiAware = Native.SetProcessDpiAwarenessContext(Native.DpiAwarenessContextPerMonitorAwareV2);
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? id = null;
            JsonObject response;
            try
            {
                var request = JsonNode.Parse(line)?.AsObject() ?? throw new HelperException("invalid_request", "Expected a JSON object.");
                id = request["id"]?.DeepClone();
                var op = request["op"]?.GetValue<string>() ?? throw new HelperException("invalid_request", "Missing op.");
                var parameters = request["params"] as JsonObject ?? [];
                var result = await HandleAsync(op, parameters, dpiAware);
                response = new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result };
            }
            catch (HelperException error)
            {
                response = Error(id, error.Code, error.Message);
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or KeyNotFoundException)
            {
                response = Error(id, "invalid_request", error.Message);
            }
            catch (Exception error)
            {
                response = Error(id, "unavailable", error.GetType().Name);
            }
            await output.WriteLineAsync(response.ToJsonString());
        }
        return 0;
    }

    private static JsonObject Error(JsonNode? id, string code, string message)
        => new() { ["id"] = id, ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    private static async Task<JsonNode?> HandleAsync(string op, JsonObject parameters, bool dpiAware)
    {
        if (op == "hello")
        {
            if (parameters["protocol"]?.GetValue<int>() != Protocol) throw new HelperException("invalid_request", "Unsupported protocol.");
            var ids = parameters["selfProcessIds"]?.AsArray().Select(node => node!.GetValue<uint>()) ?? [];
            var exes = parameters["selfExecutables"]?.AsArray().Select(node => node!.GetValue<string>()) ?? [];
            _exclusions = new Exclusions(ids, exes);
            _apps = new Apps(_exclusions);
            return new JsonObject
            {
                ["protocol"] = Protocol,
                ["version"] = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0",
                ["platform"] = "win32",
                ["dpiAwareness"] = dpiAware ? "per_monitor_v2" : "unknown",
            };
        }
        if (_exclusions is null || _apps is null) throw new HelperException("invalid_request", "Send hello first.");

        switch (op)
        {
            case "resolve_apps":
            {
                var queries = parameters["queries"]!.AsArray().Select(node => node!.GetValue<string>()).ToList();
                var matches = await _apps.ResolveAsync(queries);
                return new JsonObject
                {
                    ["matches"] = new JsonArray(matches.Select(match => (JsonNode)new JsonObject
                    {
                        ["query"] = match.Query,
                        ["candidates"] = JsonSerializer.SerializeToNode(match.Candidates, Json),
                    }).ToArray()),
                };
            }
            case "list_windows":
            {
                var paths = new HashSet<string>(
                    parameters["paths"]!.AsArray().Select(node => node!.GetValue<string>()), StringComparer.OrdinalIgnoreCase);
                var windows = WindowCatalog.All()
                    .Where(window => paths.Contains(window.Path) && _exclusions.Category(window.Path, window.Pid) != "excluded")
                    .ToList();
                return new JsonObject { ["windows"] = JsonSerializer.SerializeToNode(windows, Json) };
            }
            case "capture_window":
            {
                var window = Allowed(parameters["hwnd"]!.GetValue<long>());
                var maxEdge = Math.Clamp(parameters["maxEdge"]?.GetValue<int>() ?? 1568, 256, 2048);
                return JsonSerializer.SerializeToNode(await Capture.WindowAsync(window.Hwnd, maxEdge), Json);
            }
            case "read_ui":
            {
                var window = Allowed(parameters["hwnd"]!.GetValue<long>());
                var maxNodes = Math.Clamp(parameters["maxNodes"]?.GetValue<int>() ?? 200, 1, 1000);
                var (nodes, truncated) = Uia.Read(window.Hwnd, maxNodes, window.Bounds);
                return new JsonObject { ["nodes"] = JsonSerializer.SerializeToNode(nodes, Json), ["truncated"] = truncated };
            }
            case "open_app":
            {
                var path = parameters["path"]!.GetValue<string>();
                var pid = _apps.Open(path, parameters["aumid"]?.GetValue<string>());
                return new JsonObject { ["pid"] = pid };
            }
            case "state":
                return new JsonObject { ["locked"] = IsLocked(), ["idleMs"] = IdleMilliseconds() };
            case "cancel":
                // Ops run one at a time and observation ops are short, so nothing is ever in flight to cancel.
                return new JsonObject { ["cancelled"] = false };
            default:
                throw new HelperException("invalid_request", $"Unknown op {op}.");
        }
    }

    private static WindowInfo Allowed(long hwnd)
    {
        var window = WindowCatalog.Find(hwnd) ?? throw new HelperException("window_gone", "The window no longer exists.");
        if (_exclusions!.Category(window.Path, window.Pid) == "excluded") throw new HelperException("excluded_app", "This app can never be granted.");
        return window;
    }

    private static bool IsLocked()
    {
        var desktop = Native.OpenInputDesktop(0, false, Native.DesktopReadObjects);
        if (desktop == IntPtr.Zero) return true;
        try
        {
            var name = new StringBuilder(256);
            return !Native.GetUserObjectInformationW(desktop, Native.UoiName, name, name.Capacity * 2, out _)
                || !name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Native.CloseDesktop(desktop);
        }
    }

    private static long IdleMilliseconds()
    {
        var info = new Native.LastInputInfo { Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf<Native.LastInputInfo>() };
        return Native.GetLastInputInfo(ref info) ? unchecked((uint)Environment.TickCount - info.Time) : -1;
    }
}
