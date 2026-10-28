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

    public static (List<UiNode> Nodes, bool Truncated) Read(long hwndValue, int maxNodes, Bounds frame)
    {
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
        return (nodes, truncated);
    }

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
        void GetFocusedElement();
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
    }
}
