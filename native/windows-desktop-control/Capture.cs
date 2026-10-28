using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Cats.DesktopControl.Windows;

internal sealed record CaptureResult(string PngBase64, int Width, int Height, double Scale, Bounds Bounds);

/// <summary>
/// SPEC-133 R4: PrintWindow with PW_RENDERFULLCONTENT renders the window itself, not the
/// screen, so a window lying on top of it never appears in the image.
/// </summary>
internal static class Capture
{
    public static async Task<CaptureResult> WindowAsync(long hwndValue, int maxEdge)
    {
        var hwnd = new IntPtr(hwndValue);
        if (!Native.IsWindow(hwnd)) throw new HelperException("window_gone", "The window no longer exists.");
        if (Native.IsIconic(hwnd)) throw new HelperException("capture_failed", "The window is minimized.");
        Native.GetWindowRect(hwnd, out var rect);
        var frame = Native.FrameBounds(hwnd);
        if (rect.Width <= 0 || rect.Height <= 0 || frame.Width <= 0 || frame.Height <= 0)
        {
            throw new HelperException("capture_failed", "The window has no visible area.");
        }

        var full = Render(hwnd, rect.Width, rect.Height);
        var crop = Crop(full, rect.Width, frame.Left - rect.Left, frame.Top - rect.Top, frame.Width, frame.Height);
        if (IsUniform(crop)) throw new HelperException("capture_failed", "The window rendered a blank frame.");

        var scale = Math.Min(1.0, maxEdge / (double)Math.Max(frame.Width, frame.Height));
        var width = Math.Max(1, (int)Math.Round(frame.Width * scale));
        var height = Math.Max(1, (int)Math.Round(frame.Height * scale));
        var png = await EncodePngAsync(crop, frame.Width, frame.Height, width, height);
        return new CaptureResult(Convert.ToBase64String(png), width, height, width / (double)frame.Width, Bounds.From(frame));
    }

    private static byte[] Render(IntPtr hwnd, int width, int height)
    {
        var screen = Native.GetDC(IntPtr.Zero);
        var memory = Native.CreateCompatibleDC(screen);
        var bitmap = Native.CreateCompatibleBitmap(screen, width, height);
        var previous = Native.SelectObject(memory, bitmap);
        try
        {
            if (!Native.PrintWindow(hwnd, memory, Native.PwRenderFullContent))
            {
                throw new HelperException("capture_failed", "PrintWindow failed.");
            }
            var header = new Native.BitmapInfoHeader
            {
                Size = (uint)System.Runtime.InteropServices.Marshal.SizeOf<Native.BitmapInfoHeader>(),
                Width = width,
                Height = -height, // top-down rows
                Planes = 1,
                BitCount = 32,
            };
            var pixels = new byte[width * height * 4];
            Native.SelectObject(memory, previous);
            if (Native.GetDIBits(memory, bitmap, 0, (uint)height, pixels, ref header, 0) == 0)
            {
                throw new HelperException("capture_failed", "Reading the rendered bitmap failed.");
            }
            return pixels;
        }
        finally
        {
            Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    private static byte[] Crop(byte[] source, int sourceWidth, int left, int top, int width, int height)
    {
        var result = new byte[width * height * 4];
        for (var row = 0; row < height; row++)
        {
            System.Buffer.BlockCopy(source, ((top + row) * sourceWidth + left) * 4, result, row * width * 4, width * 4);
        }
        for (var i = 3; i < result.Length; i += 4) result[i] = 255;
        return result;
    }

    private static bool IsUniform(byte[] pixels)
    {
        for (var i = 4; i < pixels.Length; i += 4)
        {
            if (pixels[i] != pixels[0] || pixels[i + 1] != pixels[1] || pixels[i + 2] != pixels[2]) return false;
        }
        return true;
    }

    private static async Task<byte[]> EncodePngAsync(byte[] bgra, int width, int height, int outWidth, int outHeight)
    {
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, (uint)width, (uint)height, 96, 96, bgra);
        if (outWidth != width || outHeight != height)
        {
            encoder.BitmapTransform.ScaledWidth = (uint)outWidth;
            encoder.BitmapTransform.ScaledHeight = (uint)outHeight;
            encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        }
        await encoder.FlushAsync();
        var bytes = new byte[stream.Size];
        stream.Seek(0);
        await stream.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
        return bytes;
    }
}
