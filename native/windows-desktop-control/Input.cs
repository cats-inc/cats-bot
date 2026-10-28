using System.Runtime.InteropServices;

namespace Cats.DesktopControl.Windows;

/// <summary>
/// SPEC-133 R5 input. Every op re-checks its target right before injecting: the window is still
/// the expected one, may take input, is in front, and the owner is not using the computer.
/// Input this helper injects is told apart from the owner's, so its own clicks never read as
/// the owner being active.
/// </summary>
internal static class Input
{
    private const int OperatorQuietMs = 3_000;
    private const int OwnInputSlackMs = 250;
    private static uint _lastInjection;
    private static uint _lastOperatorInput = LastInputTick();
    private static readonly int InputSize = Marshal.SizeOf<Native.Input>();

    private static readonly Dictionary<string, (ushort Vk, bool Extended)> Keys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = (0x0D, false), ["esc"] = (0x1B, false), ["escape"] = (0x1B, false), ["tab"] = (0x09, false),
        ["up"] = (0x26, true), ["down"] = (0x28, true), ["left"] = (0x25, true), ["right"] = (0x27, true),
        ["pageup"] = (0x21, true), ["pagedown"] = (0x22, true), ["home"] = (0x24, true), ["end"] = (0x23, true),
        ["backspace"] = (0x08, false), ["delete"] = (0x2E, true),
    };

    private static readonly HashSet<char> ControlLetters = ['a', 'c', 'v', 'x', 'z', 'y', 's', 'f'];
    private static readonly HashSet<char> ClipboardLetters = ['a', 'c', 'v', 'x'];

    private static uint LastInputTick()
    {
        var info = new Native.LastInputInfo { Size = (uint)Marshal.SizeOf<Native.LastInputInfo>() };
        return Native.GetLastInputInfo(ref info) ? info.Time : 0;
    }

    /// <summary>Milliseconds since the owner's last input, ignoring input this helper injected.</summary>
    public static long OperatorIdleMs()
    {
        var last = LastInputTick();
        if (_lastInjection == 0 || unchecked((int)(last - _lastInjection)) > OwnInputSlackMs) _lastOperatorInput = last;
        return unchecked((uint)Environment.TickCount - _lastOperatorInput);
    }

    private static void Send(Native.Input[] events)
    {
        OperatorIdleMs(); // fold the owner's input before ours replaces it
        var sent = Native.SendInput((uint)events.Length, events, InputSize);
        _lastInjection = (uint)Environment.TickCount;
        if (sent != events.Length) throw new HelperException("elevated_target", "Windows refused the input (the target may be elevated).");
    }

    /// <summary>The guards every input op shares (SPEC-133 R5): owner idle, input-capable, unelevated, in front.</summary>
    public static WindowInfo Prepare(long hwndValue, Exclusions exclusions)
    {
        var window = WindowCatalog.Find(hwndValue) ?? throw new HelperException("window_changed", "The window is gone; call list_windows again.");
        var category = exclusions.Category(window.Path, window.Pid);
        if (category == "excluded") throw new HelperException("excluded_app", "This app can never be granted.");
        if (category == "observe_only") throw new HelperException("observe_only", "This app can only be observed.");
        if (OperatorIdleMs() < OperatorQuietMs) throw new HelperException("operator_active", "The owner is using the computer; try again shortly.");
        foreach (var key in new[] { 0x01, 0x02, 0x04, 0x10, 0x11, 0x12, 0x5B, 0x5C })
        {
            if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new HelperException("operator_active", "A key or mouse button is held down.");
        }
        if (IsElevated(window.Pid)) throw new HelperException("elevated_target", "The window runs elevated; Cats cannot send it input.");
        BringToFront(window);
        return window;
    }

    private static bool IsElevated(uint pid)
    {
        var process = Native.OpenProcess(Native.ProcessQueryLimitedInformation, false, pid);
        if (process == IntPtr.Zero) return true;
        try
        {
            var target = Native.IntegrityLevel(process);
            var own = Native.IntegrityLevel(Native.GetCurrentProcess());
            return target is null || own is null || target > own;
        }
        finally
        {
            Native.CloseHandle(process);
        }
    }

    private static void BringToFront(WindowInfo window)
    {
        var hwnd = new IntPtr(window.Hwnd);
        if (Native.RootOf(Native.GetForegroundWindow()) == hwnd) return;
        if (window.Minimized) throw new HelperException("not_foreground", "The window is minimized.");
        Native.SetForegroundWindow(hwnd);
        if (Native.RootOf(Native.GetForegroundWindow()) != hwnd) Uia.Focus(window.Hwnd);
        Thread.Sleep(80);
        if (Native.RootOf(Native.GetForegroundWindow()) != hwnd) throw new HelperException("not_foreground", "The window could not be brought to the front.");
    }

    /// <summary>Coordinate guards from the developer skill (PR #336): unmoved window, point inside it, nothing covering it.</summary>
    private static void CheckPoint(WindowInfo window, Bounds expected, int x, int y)
    {
        if (window.Bounds != expected) throw new HelperException("window_changed", "The window moved or resized since the screenshot.");
        if (x < expected.X || y < expected.Y || x >= expected.X + expected.Width || y >= expected.Y + expected.Height)
        {
            throw new HelperException("window_changed", "The point is outside the window.");
        }
        var root = Native.GetAncestor(Native.WindowFromPoint(new Native.Point { X = x, Y = y }), Native.GaRootOwner);
        if (root.ToInt64() != window.Hwnd) throw new HelperException("covered", "Another window covers that point.");
        if (!Native.SetCursorPos(x, y) || !Native.GetCursorPos(out var landed) || landed.X != x || landed.Y != y)
        {
            throw new HelperException("window_changed", "The cursor did not land on the requested point.");
        }
    }

    public static void Click(WindowInfo window, Bounds expected, int x, int y, string button, int count)
    {
        CheckPoint(window, expected, x, y);
        var swapped = Native.GetSystemMetrics(Native.SmSwapButton) != 0;
        (uint down, uint up) = button switch
        {
            "middle" => (Native.MouseMiddleDown, Native.MouseMiddleUp),
            "right" when !swapped => (Native.MouseRightDown, Native.MouseRightUp),
            "right" => (Native.MouseLeftDown, Native.MouseLeftUp),
            _ when swapped => (Native.MouseRightDown, Native.MouseRightUp),
            _ => (Native.MouseLeftDown, Native.MouseLeftUp),
        };
        var events = new Native.Input[count * 2];
        for (var i = 0; i < events.Length; i++)
        {
            events[i].Type = Native.InputMouse;
            events[i].Data.Mouse.Flags = i % 2 == 0 ? down : up;
        }
        Send(events);
    }

    public static void Scroll(WindowInfo window, Bounds expected, int x, int y, string direction, int amount)
    {
        CheckPoint(window, expected, x, y);
        var horizontal = direction is "left" or "right";
        var delta = 120 * amount * (direction is "down" or "left" ? -1 : 1);
        var input = new Native.Input { Type = Native.InputMouse };
        input.Data.Mouse.Flags = horizontal ? Native.MouseHWheel : Native.MouseWheel;
        input.Data.Mouse.Data = unchecked((uint)delta);
        Send([input]);
    }

    /// <summary>Types in chunks so Stop takes effect between them, re-checking focus each time.</summary>
    public static void Type(WindowInfo window, string text, CancellationToken cancel)
    {
        Uia.RequireTypingTarget(window, allowPassword: false);
        const int chunk = 16;
        for (var start = 0; start < text.Length; start += chunk)
        {
            if (cancel.IsCancellationRequested) throw new HelperException("stopped", "Typing was stopped.");
            if (Native.RootOf(Native.GetForegroundWindow()).ToInt64() != window.Hwnd)
            {
                throw new HelperException("not_foreground", "The window lost focus while typing.");
            }
            var part = text.Substring(start, Math.Min(chunk, text.Length - start));
            var events = new Native.Input[part.Length * 2];
            for (var i = 0; i < part.Length; i++)
            {
                for (var j = 0; j < 2; j++)
                {
                    ref var e = ref events[i * 2 + j];
                    e.Type = Native.InputKeyboard;
                    e.Data.Keyboard.Scan = part[i];
                    e.Data.Keyboard.Flags = Native.KeyUnicode | (j == 1 ? Native.KeyUp : 0);
                }
            }
            Send(events);
            Thread.Sleep(15);
        }
    }

    /// <summary>One allowlisted chord (SPEC-133 R5); clipboard chords are refused in password fields.</summary>
    public static void Key(WindowInfo window, string keys)
    {
        var normalized = keys.Trim().ToLowerInvariant();
        ushort vk; var extended = false; var control = false;
        if (normalized.StartsWith("ctrl+", StringComparison.Ordinal) && normalized.Length == 6 && ControlLetters.Contains(normalized[5]))
        {
            control = true;
            vk = char.ToUpperInvariant(normalized[5]);
            Uia.RequireTypingTarget(window, allowPassword: !ClipboardLetters.Contains(normalized[5]));
        }
        else if (Keys.TryGetValue(normalized, out var key))
        {
            (vk, extended) = key;
        }
        else if (normalized.Length is 2 or 3 && normalized[0] == 'f' && int.TryParse(normalized[1..], out var number) && number is >= 1 and <= 12)
        {
            vk = (ushort)(0x6F + number);
        }
        else
        {
            throw new HelperException("invalid_request", "That key is not allowed.");
        }
        var list = new List<Native.Input>();
        void Add(ushort code, bool up, bool ext)
        {
            var e = new Native.Input { Type = Native.InputKeyboard };
            e.Data.Keyboard.Vk = code;
            e.Data.Keyboard.Flags = (up ? Native.KeyUp : 0) | (ext ? Native.KeyExtended : 0);
            list.Add(e);
        }
        if (control) Add(0x11, false, false);
        Add(vk, false, extended);
        Add(vk, true, extended);
        if (control) Add(0x11, true, false);
        Send(list.ToArray());
    }
}
