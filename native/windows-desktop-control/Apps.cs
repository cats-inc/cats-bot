using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml.Linq;
using Windows.Management.Deployment;

namespace Cats.DesktopControl.Windows;

internal sealed record AppCandidate(
    string Path, string? Publisher, string ProductName, string DisplayName, bool Running, string Category, string? Aumid);

/// <summary>
/// Resolves owner-facing app names to executable identities. Sources are running windows,
/// Start menu shortcuts and packaged apps, so localized display names (such as 記事本) resolve.
/// </summary>
internal sealed class Apps
{
    private readonly Exclusions _exclusions;
    private readonly Dictionary<string, string?> _publishers = new(StringComparer.OrdinalIgnoreCase);
    private List<AppCandidate>? _installed;
    private DateTime _installedAt;

    public Apps(Exclusions exclusions) => _exclusions = exclusions;

    public async Task<List<(string Query, List<AppCandidate> Candidates)>> ResolveAsync(IReadOnlyList<string> queries)
    {
        var all = Merge(Running().Concat(await InstalledAsync()));
        return queries.Select(query =>
        {
            var key = query.Trim();
            var ranked = all
                .Select(candidate => (Candidate: candidate, Score: Score(candidate, key)))
                .Where(item => item.Score > 0)
                .OrderByDescending(item => item.Score)
                .ThenByDescending(item => item.Candidate.Running)
                .Take(5)
                .Select(item => item.Candidate)
                .ToList();
            return (query, ranked);
        }).ToList();
    }

    public uint Open(string path, string? aumid)
    {
        if (_exclusions.Category(path) == "excluded") throw new HelperException("excluded_app", "This app can never be granted.");
        if (!string.IsNullOrEmpty(aumid))
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            return manager.ActivateApplication(aumid, null, 0);
        }
        if (!File.Exists(path)) throw new HelperException("not_found", "The executable no longer exists.");
        using var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        return process is null ? 0u : (uint)process.Id;
    }

    private IEnumerable<AppCandidate> Running()
        => WindowCatalog.All()
            .GroupBy(window => window.Path, StringComparer.OrdinalIgnoreCase)
            .Select(group => Describe(group.Key, null, running: true, aumid: null, group.First().Pid));

    private async Task<List<AppCandidate>> InstalledAsync()
    {
        if (_installed is not null && DateTime.UtcNow - _installedAt < TimeSpan.FromMinutes(5)) return _installed;
        var found = new List<AppCandidate>();
        found.AddRange(Shortcuts());
        try
        {
            found.AddRange(await PackagedAsync());
        }
        catch (Exception error) when (error is COMException or UnauthorizedAccessException)
        {
            // Packaged apps stay resolvable while they run; the index is best effort.
        }
        _installed = found;
        _installedAt = DateTime.UtcNow;
        return found;
    }

    private IEnumerable<AppCandidate> Shortcuts()
    {
        var roots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs"),
        };
        foreach (var root in roots.Where(Directory.Exists))
        {
            IEnumerable<string> links;
            try
            {
                links = Directory.EnumerateFiles(root, "*.lnk", SearchOption.AllDirectories).Take(2000).ToList();
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var link in links)
            {
                var target = ShortcutTarget(link);
                if (target is null || !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(target)) continue;
                var info = new Native.ShFileInfo();
                Native.SHGetFileInfoW(link, 0, ref info, (uint)Marshal.SizeOf<Native.ShFileInfo>(), Native.ShgfiDisplayName);
                var display = string.IsNullOrWhiteSpace(info.DisplayName) ? Path.GetFileNameWithoutExtension(link) : info.DisplayName;
                yield return Describe(target, display, running: false, aumid: null, processId: null);
            }
        }
    }

    private async Task<List<AppCandidate>> PackagedAsync()
    {
        var found = new List<AppCandidate>();
        foreach (var package in new PackageManager().FindPackagesForUser(string.Empty))
        {
            if (package.IsFramework || package.IsResourcePackage) continue;
            string installed;
            try
            {
                installed = package.InstalledLocation.Path;
            }
            catch (Exception error) when (error is COMException or FileNotFoundException or UnauthorizedAccessException)
            {
                continue;
            }
            var executables = ManifestExecutables(installed);
            foreach (var entry in await package.GetAppListEntriesAsync())
            {
                var appId = entry.AppUserModelId.Split('!').LastOrDefault() ?? string.Empty;
                if (!executables.TryGetValue(appId, out var executable)) continue;
                var path = Path.Combine(installed, executable);
                found.Add(Describe(path, entry.DisplayInfo.DisplayName, running: false, entry.AppUserModelId, null,
                    package.PublisherDisplayName));
            }
        }
        return found;
    }

    private static Dictionary<string, string> ManifestExecutables(string installed)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var manifest = Path.Combine(installed, "AppxManifest.xml");
        if (!File.Exists(manifest)) return result;
        try
        {
            foreach (var application in XDocument.Load(manifest).Descendants().Where(element => element.Name.LocalName == "Application"))
            {
                var id = application.Attribute("Id")?.Value;
                var executable = application.Attribute("Executable")?.Value;
                if (id is not null && executable is not null) result[id] = executable;
            }
        }
        catch (System.Xml.XmlException)
        {
            // An unreadable manifest only hides that package from name resolution.
        }
        return result;
    }

    private AppCandidate Describe(string path, string? display, bool running, string? aumid, uint? processId,
        string? packagePublisher = null)
    {
        string productName;
        string description;
        try
        {
            var version = FileVersionInfo.GetVersionInfo(path);
            productName = version.ProductName?.Trim() is { Length: > 0 } product ? product : Path.GetFileNameWithoutExtension(path);
            description = version.FileDescription?.Trim() is { Length: > 0 } text ? text : productName;
        }
        catch (FileNotFoundException)
        {
            productName = description = Path.GetFileNameWithoutExtension(path);
        }
        return new AppCandidate(path, packagePublisher ?? Publisher(path), productName, display ?? description, running,
            _exclusions.Category(path, processId), aumid);
    }

    private string? Publisher(string path)
    {
        if (_publishers.TryGetValue(path, out var cached)) return cached;
        string? publisher = null;
        try
        {
#pragma warning disable SYSLIB0057 // The signer's display name is all that is read here.
            using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
            publisher = certificate.GetNameInfo(X509NameType.SimpleName, false);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            // Unsigned executables have no publisher.
        }
        return _publishers[path] = publisher;
    }

    /// <summary>Merges candidates for the same executable; a running copy and an AUMID both survive.</summary>
    private static List<AppCandidate> Merge(IEnumerable<AppCandidate> candidates)
        => candidates
            .GroupBy(candidate => candidate.Path, StringComparer.OrdinalIgnoreCase)
            .SelectMany(group =>
            {
                var running = group.Any(candidate => candidate.Running);
                var aumid = group.Select(candidate => candidate.Aumid).FirstOrDefault(id => id is not null);
                return group
                    .Select(candidate => candidate with { Running = running, Aumid = candidate.Aumid ?? aumid })
                    .DistinctBy(candidate => candidate.DisplayName, StringComparer.OrdinalIgnoreCase);
            })
            .ToList();

    private static int Score(AppCandidate candidate, string query)
    {
        if (query.Length == 0) return 0;
        var names = new[] { candidate.DisplayName, candidate.ProductName, Path.GetFileNameWithoutExtension(candidate.Path) };
        if (names.Any(name => name.Equals(query, StringComparison.CurrentCultureIgnoreCase))) return 3;
        if (names.Any(name => name.StartsWith(query, StringComparison.CurrentCultureIgnoreCase))) return 2;
        return names.Any(name => name.Contains(query, StringComparison.CurrentCultureIgnoreCase)) ? 1 : 0;
    }

    private static string? ShortcutTarget(string link)
    {
        try
        {
            var shell = (IShellLinkW)new ShellLink();
            ((IPersistFile)shell).Load(link, 0);
            var target = new StringBuilder(32768);
            shell.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            return target.Length > 0 ? target.ToString() : null;
        }
        catch (Exception error) when (error is COMException or UnauthorizedAccessException or FileNotFoundException)
        {
            return null;
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink;

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager;

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        uint ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string? arguments, int options);
    }
}
