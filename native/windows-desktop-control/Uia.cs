using System.Runtime.InteropServices;

namespace Cats.DesktopControl.Windows;

internal sealed record UiNode(
    string ElementId, string? ParentId, string Role, string Name, string? Value,
    bool Enabled, bool Focused, Bounds? Bounds, string[] Actions);

/// <summary>
/// Reads a window's UI Automation control view through the COM client (UIAutomationCore),
/// so the helper needs neither the WPF runtime nor a third-party interop package.
/// Only the vtable slots this file calls are typed; earlier slots are placeholders.
/// </summary>
internal static class Uia
{
    private const int BoundingRectangle = 30001;
    private const int ProcessId = 30002;
    private const int MaxCachedReads = 8;
    private static readonly object CacheLock = new();
    private static readonly LinkedList<(int ReadId, long Hwnd, Dictionary<string, IUIAutomationElement> Elements)> Reads = new();
    private static int _nextReadId;
    private const int ControlType = 30003;
    private const int LocalizedControlType = 30004;
    private const int Name = 30005;
    private const int HasKeyboardFocus = 30008;
    private const int IsEnabled = 30010;
    private const int IsPassword = 30019;
    private const int IsOffscreen = 30022;
    private const int IsExpandCollapseAvailable = 30028;
    private const int IsInvokeAvailable = 30031;
    private const int IsSelectionItemAvailable = 30036;
    private const int IsToggleAvailable = 30041;
    private const int IsValueAvailable = 30043;
    private const int ValueValue = 30045;
    private const int ValueIsReadOnly = 30046;

    private static readonly string[] Roles =
    [
        "button", "calendar", "checkbox", "combobox", "edit", "hyperlink", "image", "listitem", "list", "menu",
        "menubar", "menuitem", "progressbar", "radiobutton", "scrollbar", "slider", "spinner", "statusbar", "tab",
        "tabitem", "text", "toolbar", "tooltip", "tree", "treeitem", "custom", "group", "thumb", "datagrid",
        "dataitem", "document", "splitbutton", "window", "pane", "header", "headeritem", "table", "titlebar",
        "separator", "semanticzoom", "appbar",
    ];

    public static (int ReadId, List<UiNode> Nodes, bool Truncated) Read(long hwndValue, int maxNodes, Bounds frame)
    {
        var elements = new Dictionary<string, IUIAutomationElement>();
        var hwnd = new IntPtr(hwndValue);
        if (!Native.IsWindow(hwnd)) throw new HelperException("window_gone", "The window no longer exists.");
        var automation = (IUIAutomation)new CUIAutomation();
        var walker = automation.GetControlViewWalker();
        var root = automation.ElementFromHandle(hwnd)
            ?? throw new HelperException("window_gone", "The window exposes no UI Automation element.");

        var nodes = new List<UiNode>();
        var queue = new Queue<(IUIAutomationElement Element, string? ParentId)>();
        queue.Enqueue((root, null));
        var truncated = false;
        while (queue.Count > 0)
        {
            if (nodes.Count >= maxNodes)
            {
                truncated = true;
                break;
            }
            var (element, parentId) = queue.Dequeue();
            UiNode node;
            try
            {
                if (parentId is not null && Bool(element, IsOffscreen)) continue;
                node = Describe(element, $"e{nodes.Count}", parentId, frame);
            }
            catch (COMException)
            {
                continue; // The element went away while it was being read.
            }
            nodes.Add(node);
            elements[node.ElementId] = element;
            try
            {
                for (var child = walker.GetFirstChildElement(element); child is not null; child = walker.GetNextSiblingElement(child))
                {
                    queue.Enqueue((child, node.ElementId));
                }
            }
            catch (COMException)
            {
                // Children of a vanished element are skipped.
            }
        }
        int readId;
        lock (CacheLock)
        {
            // invoke_element resolves ids from the last few reads; older ones answer window_changed.
            readId = ++_nextReadId;
            Reads.AddFirst((readId, hwndValue, elements));
            while (Reads.Count > MaxCachedReads) Reads.RemoveLast();
        }
        return (readId, nodes, truncated);
    }

    /// <summary>UIA SetFocus on the window brings it forward when SetForegroundWindow is refused (skill note).</summary>
    public static void Focus(long hwnd)
    {
        try
        {
            var automation = (IUIAutomation)new CUIAutomation();
            automation.ElementFromHandle(new IntPtr(hwnd))?.SetFocus();
        }
        catch (COMException)
        {
            // The caller verifies the foreground window and reports not_foreground.
        }
    }

    /// <summary>Typing needs keyboard focus inside the target window and, unless allowed, outside password fields.</summary>
    public static void RequireTypingTarget(WindowInfo window, bool allowPassword)
    {
        IUIAutomationElement? focused;
        try
        {
            focused = ((IUIAutomation)new CUIAutomation()).GetFocusedElement();
        }
        catch (COMException)
        {
            focused = null;
        }
        if (focused is null || focused.GetCurrentPropertyValue(ProcessId) is not int pid || pid != window.Pid)
        {
            throw new HelperException("not_foreground", "Keyboard focus is not inside the window.");
        }
        if (!allowPassword && Bool(focused, IsPassword)) throw new HelperException("password_field", "The focused field is a password field.");
    }

    /// <summary>invoke_element: a UIA pattern on an element from a recent read_ui of the same window.</summary>
    public static void Invoke(WindowInfo window, int readId, string elementId, string action)
    {
        IUIAutomationElement? element = null;
        lock (CacheLock)
        {
            foreach (var read in Reads)
            {
                if (read.ReadId == readId && read.Hwnd == window.Hwnd) read.Elements.TryGetValue(elementId, out element);
            }
        }
        if (element is null) throw new HelperException("window_changed", "That element is no longer known; call read_ui again.");
        try
        {
            if (element.GetCurrentPropertyValue(ProcessId) is not int pid || pid != window.Pid)
            {
                throw new HelperException("window_changed", "That element no longer belongs to the window.");
            }
            switch (action)
            {
                case "invoke": Pattern<IUIAutomationInvokePattern>(element, 10000).Invoke(); break;
                case "toggle": Pattern<IUIAutomationTogglePattern>(element, 10015).Toggle(); break;
                case "select": Pattern<IUIAutomationSelectionItemPattern>(element, 10010).Select(); break;
                case "expand": Pattern<IUIAutomationExpandCollapsePattern>(element, 10005).Expand(); break;
                case "collapse": Pattern<IUIAutomationExpandCollapsePattern>(element, 10005).Collapse(); break;
                default: throw new HelperException("invalid_request", "Unknown action.");
            }
        }
        catch (COMException)
        {
            throw new HelperException("window_changed", "The element went away or refused the action; call read_ui again.");
        }
    }

    private static T Pattern<T>(IUIAutomationElement element, int patternId) where T : class
        => element.GetCurrentPattern(patternId) as T
            ?? throw new HelperException("invalid_request", "The element does not support that action.");

    private static UiNode Describe(IUIAutomationElement element, string id, string? parentId, Bounds frame)
    {
        var controlType = element.GetCurrentPropertyValue(ControlType) is int type ? type - 50000 : -1;
        var role = controlType >= 0 && controlType < Roles.Length
            ? Roles[controlType]
            : Text(element, LocalizedControlType) ?? "unknown";
        var password = Bool(element, IsPassword);
        var valueAvailable = Bool(element, IsValueAvailable);
        string? value = null;
        if (valueAvailable && !password) value = Truncate(Text(element, ValueValue), 500);

        var actions = new List<string>();
        if (Bool(element, IsInvokeAvailable)) actions.Add("invoke");
        if (Bool(element, IsToggleAvailable)) actions.Add("toggle");
        if (Bool(element, IsSelectionItemAvailable)) actions.Add("select");
        if (Bool(element, IsExpandCollapseAvailable)) actions.AddRange(["expand", "collapse"]);
        if (valueAvailable && !password && !Bool(element, ValueIsReadOnly)) actions.Add("value");

        Bounds? bounds = null;
        if (element.GetCurrentPropertyValue(BoundingRectangle) is double[] { Length: 4 } rect && rect[2] > 0 && rect[3] > 0)
        {
            bounds = new Bounds((int)rect[0] - frame.X, (int)rect[1] - frame.Y, (int)rect[2], (int)rect[3]);
        }

        return new UiNode(id, parentId, role, Truncate(Text(element, Name), 200) ?? string.Empty, value,
            Bool(element, IsEnabled), Bool(element, HasKeyboardFocus), bounds, actions.ToArray());
    }

    private static bool Bool(IUIAutomationElement element, int property)
        => element.GetCurrentPropertyValue(property) is bool flag && flag;

    private static string? Text(IUIAutomationElement element, int property)
        => element.GetCurrentPropertyValue(property) as string;

    private static string? Truncate(string? text, int max)
        => text is null || text.Length <= max ? text : text[..max];

    [ComImport, Guid("ff48dba4-60ef-4201-aa87-54103eef594e")]
    private class CUIAutomation;

    [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomation
    {
        void CompareElements();
        void CompareRuntimeIds();
        void GetRootElement();
        IUIAutomationElement? ElementFromHandle(IntPtr hwnd);
        void ElementFromPoint();
        IUIAutomationElement? GetFocusedElement();
        void GetRootElementBuildCache();
        void ElementFromHandleBuildCache();
        void ElementFromPointBuildCache();
        void GetFocusedElementBuildCache();
        void CreateTreeWalker();
        IUIAutomationTreeWalker GetControlViewWalker();
    }

    [ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationTreeWalker
    {
        void GetParentElement();
        IUIAutomationElement? GetFirstChildElement(IUIAutomationElement element);
        void GetLastChildElement();
        IUIAutomationElement? GetNextSiblingElement(IUIAutomationElement element);
    }

    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationElement
    {
        void SetFocus();
        void GetRuntimeId();
        void FindFirst();
        void FindAll();
        void FindFirstBuildCache();
        void FindAllBuildCache();
        void BuildUpdatedCache();
        [return: MarshalAs(UnmanagedType.Struct)]
        object? GetCurrentPropertyValue(int propertyId);
        void GetCurrentPropertyValueEx();
        void GetCachedPropertyValue();
        void GetCachedPropertyValueEx();
        void GetCurrentPatternAs();
        void GetCachedPatternAs();
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object? GetCurrentPattern(int patternId);
    }

    [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationInvokePattern
    {
        void Invoke();
    }

    [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationTogglePattern
    {
        void Toggle();
    }

    [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationSelectionItemPattern
    {
        void Select();
    }

    [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IUIAutomationExpandCollapsePattern
    {
        void Expand();
        void Collapse();
    }
}
