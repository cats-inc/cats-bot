namespace Cats.DesktopControl.Windows;

/// <summary>SPEC-133 DC-10. Matching is on the executable file name, case-insensitive.</summary>
internal sealed class Exclusions
{
    private static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
    {
        "consent.exe", "LogonUI.exe", "CredentialUIBroker.exe", "LockApp.exe",
    };

    private static readonly HashSet<string> TerminalsAndIdes = new(StringComparer.OrdinalIgnoreCase)
    {
        "WindowsTerminal.exe", "OpenConsole.exe", "conhost.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
        "wsl.exe", "bash.exe", "mintty.exe", "Code.exe", "Code - Insiders.exe", "Cursor.exe", "Windsurf.exe",
        "devenv.exe", "idea64.exe", "pycharm64.exe", "webstorm64.exe", "rider64.exe", "clion64.exe",
        "goland64.exe", "rubymine64.exe", "phpstorm64.exe", "datagrip64.exe", "studio64.exe", "zed.exe",
    };

    private static readonly HashSet<string> Browsers = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe", "iexplore.exe",
    };

    private readonly HashSet<uint> _selfProcessIds;
    private readonly HashSet<string> _selfExecutables;

    public Exclusions(IEnumerable<uint> selfProcessIds, IEnumerable<string> selfExecutables)
    {
        _selfProcessIds = new HashSet<uint>(selfProcessIds) { (uint)Environment.ProcessId };
        _selfExecutables = new HashSet<string>(selfExecutables.Select(Normalize), StringComparer.OrdinalIgnoreCase);
        if (Environment.ProcessPath is { } own) _selfExecutables.Add(Normalize(own));
    }

    /// <summary>"excluded", "observe_only" or "normal".</summary>
    public string Category(string path, uint? processId = null)
    {
        if (processId is { } id && _selfProcessIds.Contains(id)) return "excluded";
        if (_selfExecutables.Contains(Normalize(path))) return "excluded";
        var name = Path.GetFileName(path);
        if (Excluded.Contains(name)) return "excluded";
        if (TerminalsAndIdes.Contains(name) || Browsers.Contains(name)) return "observe_only";
        return "normal";
    }

    private static string Normalize(string path)
    {
        try
        {
            return Path.GetFullPath(path).TrimEnd('\\');
        }
        catch (ArgumentException)
        {
            return path;
        }
    }
}
