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
/// Ops run one at a time in arrival order, except "cancel", which is answered at once and stops
/// the op in progress (typing checks it between chunks). Responses carry the request id.
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

        var writeLock = new SemaphoreSlim(1, 1);
        var gate = new SemaphoreSlim(1, 1);
        CancellationTokenSource? running = null;
        var pending = new List<Task>();
        async Task Write(JsonObject response)
        {
            await writeLock.WaitAsync();
            try { await output.WriteLineAsync(response.ToJsonString()); } finally { writeLock.Release(); }
        }

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? id = null;
            string op;
            JsonObject parameters;
            try
            {
                var request = JsonNode.Parse(line)?.AsObject() ?? throw new HelperException("invalid_request", "Expected a JSON object.");
                id = request["id"]?.DeepClone();
                op = request["op"]?.GetValue<string>() ?? throw new HelperException("invalid_request", "Missing op.");
                parameters = request["params"] as JsonObject ?? [];
            }
            catch (Exception error) when (error is HelperException or JsonException or InvalidOperationException)
            {
                await Write(Error(id, "invalid_request", error.Message));
                continue;
            }
            if (op == "cancel")
            {
                var current = running;
                current?.Cancel();
                await Write(new JsonObject { ["id"] = id?.DeepClone(), ["ok"] = true, ["result"] = new JsonObject { ["cancelled"] = current is not null } });
                continue;
            }
            pending.RemoveAll(task => task.IsCompleted);
            pending.Add(Task.Run(async () =>
            {
                await gate.WaitAsync();
                var cancel = new CancellationTokenSource();
                running = cancel;
                JsonObject response;
                try
                {
                    // Run the op before building the reply: a JsonNode id can belong to only one object.
                    var result = await HandleAsync(op, parameters, dpiAware, cancel.Token);
                    response = new JsonObject { ["id"] = id?.DeepClone(), ["ok"] = true, ["result"] = result };
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
                finally
                {
                    running = null;
                    gate.Release();
                }
                await Write(response);
            }));
        }
        await Task.WhenAll(pending);
        return 0;
    }

    private static JsonObject Error(JsonNode? id, string code, string message)
        => new() { ["id"] = id?.DeepClone(), ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    private static async Task<JsonNode?> HandleAsync(string op, JsonObject parameters, bool dpiAware, CancellationToken cancel)
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
                var (readId, nodes, truncated) = Uia.Read(window.Hwnd, maxNodes, window.Bounds);
                return new JsonObject { ["readId"] = readId, ["nodes"] = JsonSerializer.SerializeToNode(nodes, Json), ["truncated"] = truncated };
            }
            case "open_app":
            {
                var path = parameters["path"]!.GetValue<string>();
                var pid = _apps.Open(path, parameters["aumid"]?.GetValue<string>());
                return new JsonObject { ["pid"] = pid };
            }
            case "state":
                return new JsonObject { ["locked"] = IsLocked(), ["idleMs"] = IdleMilliseconds(), ["operatorIdleMs"] = Input.OperatorIdleMs() };
            case "click":
            {
                var window = InputTarget(parameters);
                Input.Click(window, ParseBounds(parameters), parameters["x"]!.GetValue<int>(), parameters["y"]!.GetValue<int>(),
                    parameters["button"]?.GetValue<string>() ?? "left", Math.Clamp(parameters["count"]?.GetValue<int>() ?? 1, 1, 3));
                return Done();
            }
            case "scroll":
            {
                var window = InputTarget(parameters);
                Input.Scroll(window, ParseBounds(parameters), parameters["x"]!.GetValue<int>(), parameters["y"]!.GetValue<int>(),
                    parameters["direction"]!.GetValue<string>(), Math.Clamp(parameters["amount"]!.GetValue<int>(), 1, 10));
                return Done();
            }
            case "type":
            {
                var text = parameters["text"]!.GetValue<string>();
                if (text.Length is 0 or > 2000 || text.Any(char.IsControl))
                {
                    throw new HelperException("invalid_request", "Text must be 1 to 2000 characters without control characters.");
                }
                Input.Type(InputTarget(parameters), text, cancel);
                return Done();
            }
            case "key":
                Input.Key(InputTarget(parameters), parameters["keys"]!.GetValue<string>());
                return Done();
            case "invoke":
                Uia.Invoke(InputTarget(parameters), parameters["readId"]!.GetValue<int>(), parameters["elementId"]!.GetValue<string>(),
                    parameters["action"]!.GetValue<string>());
                return Done();
            case "clipboard_read":
                return new JsonObject { ["text"] = Clipboard.Read() };
            case "clipboard_write":
                Clipboard.Write(parameters["text"]!.GetValue<string>());
                return Done();
            default:
                throw new HelperException("invalid_request", $"Unknown op {op}.");
        }
    }

    private static JsonObject Done() => new() { ["done"] = true };

    /// <summary>Input ops re-resolve the window and apply the shared guards before anything is sent.</summary>
    private static WindowInfo InputTarget(JsonObject parameters)
        => Input.Prepare(parameters["hwnd"]!.GetValue<long>(), _exclusions!);

    private static Bounds ParseBounds(JsonObject parameters)
    {
        var bounds = parameters["bounds"]!.AsObject();
        return new Bounds(bounds["x"]!.GetValue<int>(), bounds["y"]!.GetValue<int>(), bounds["width"]!.GetValue<int>(), bounds["height"]!.GetValue<int>());
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
