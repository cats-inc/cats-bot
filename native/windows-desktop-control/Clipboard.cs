using System.Runtime.InteropServices;

namespace Cats.DesktopControl.Windows;

/// <summary>SPEC-133 R5 clipboard: text only, at most 100,000 characters, a write is read back.</summary>
internal static class Clipboard
{
    public const int MaxLength = 100_000;

    private static void Open()
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            if (Native.OpenClipboard(IntPtr.Zero)) return;
            Thread.Sleep(30);
        }
        throw new HelperException("unavailable", "Another program holds the clipboard.");
    }

    public static string? Read()
    {
        Open();
        try
        {
            if (!Native.IsClipboardFormatAvailable(Native.CfUnicodeText)) return null;
            var handle = Native.GetClipboardData(Native.CfUnicodeText);
            if (handle == IntPtr.Zero) return null;
            var pointer = Native.GlobalLock(handle);
            try
            {
                var text = Marshal.PtrToStringUni(pointer);
                return text is { Length: > MaxLength } ? text[..MaxLength] : text;
            }
            finally
            {
                Native.GlobalUnlock(handle);
            }
        }
        finally
        {
            Native.CloseClipboard();
        }
    }

    public static void Write(string text)
    {
        if (text.Length is 0 or > MaxLength) throw new HelperException("invalid_request", "Clipboard text must be 1 to 100,000 characters.");
        Open();
        try
        {
            Native.EmptyClipboard();
            var bytes = (text.Length + 1) * 2;
            var memory = Native.GlobalAlloc(Native.GmemMoveable, (UIntPtr)bytes);
            if (memory == IntPtr.Zero) throw new HelperException("unavailable", "No memory for the clipboard.");
            var pointer = Native.GlobalLock(memory);
            Marshal.Copy(text.ToCharArray(), 0, pointer, text.Length);
            Marshal.WriteInt16(pointer, text.Length * 2, 0);
            Native.GlobalUnlock(memory);
            if (Native.SetClipboardData(Native.CfUnicodeText, memory) == IntPtr.Zero)
            {
                Native.GlobalFree(memory);
                throw new HelperException("unavailable", "Windows refused the clipboard text.");
            }
        }
        finally
        {
            Native.CloseClipboard();
        }
        if (Read() != text) throw new HelperException("unavailable", "Another program replaced the clipboard text.");
    }
}
