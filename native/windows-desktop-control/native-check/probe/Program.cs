namespace Cats.DesktopControl.Probe;

/// <summary>
/// The native check's input target: a window whose labels report every click, toggle, key and
/// wheel turn, so results are read back through read_ui. It closes itself after two minutes.
/// Usage: cats-desktop-control-probe [x y width height]
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var bounds = args.Length == 4 ? args.Select(int.Parse).ToArray() : [300, 200, 700, 520];
        var form = new Form
        {
            Text = "Cats DC input probe",
            StartPosition = FormStartPosition.Manual,
            Location = new Point(bounds[0], bounds[1]),
            Size = new Size(bounds[2], bounds[3]),
            KeyPreview = true,
        };
        var clicks = 0;
        var wheel = 0;
        var clickLabel = new Label { Text = "Clicks: 0", Location = new Point(200, 28), AutoSize = true };
        var button = new Button { Text = "Probe button", Location = new Point(20, 20), Size = new Size(160, 40) };
        button.Click += (_, _) => clickLabel.Text = $"Clicks: {++clicks}";
        var text = new TextBox { Location = new Point(20, 80), Width = 300, AccessibleName = "Probe text" };
        var secret = new TextBox { Location = new Point(20, 120), Width = 300, UseSystemPasswordChar = true, Text = "hunter2-secret", AccessibleName = "Probe secret" };
        var check = new CheckBox { Text = "Probe check", Location = new Point(20, 160), AutoSize = true };
        var checkLabel = new Label { Text = "Checked: False", Location = new Point(200, 162), AutoSize = true };
        check.CheckedChanged += (_, _) => checkLabel.Text = $"Checked: {check.Checked}";
        var keyLabel = new Label { Text = "Last key: none", Location = new Point(20, 200), AutoSize = true };
        form.KeyDown += (_, e) => keyLabel.Text = $"Last key: {(e.Control ? "Ctrl+" : "")}{e.KeyCode}";
        var wheelLabel = new Label { Text = "Wheel: 0", Location = new Point(20, 230), AutoSize = true };
        Application.AddMessageFilter(new WheelFilter(delta => wheelLabel.Text = $"Wheel: {wheel += delta}"));
        form.Controls.AddRange([button, clickLabel, text, secret, check, checkLabel, keyLabel, wheelLabel]);
        var timer = new System.Windows.Forms.Timer { Interval = 120_000 };
        timer.Tick += (_, _) => form.Close();
        timer.Start();
        Application.Run(form);
    }

    /// <summary>Counts wheel notches sent anywhere in the probe, whichever control is under the cursor.</summary>
    private sealed class WheelFilter(Action<int> onWheel) : IMessageFilter
    {
        public bool PreFilterMessage(ref Message message)
        {
            if (message.Msg is 0x020A or 0x020E) onWheel((short)((message.WParam.ToInt64() >> 16) & 0xFFFF) / 120);
            return false;
        }
    }
}
