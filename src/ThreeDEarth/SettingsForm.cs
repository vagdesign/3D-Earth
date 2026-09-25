using System.Diagnostics;
using System.Globalization;

namespace ThreeDEarth;

/// <summary>Settings window, built in code (no designer files).</summary>
internal sealed class SettingsForm : Form
{
    private readonly AppSettings _s;
    private readonly Action<AppSettings> _apply;
    private readonly Func<string> _status;
    private readonly Action _refreshWeather;

    private readonly ComboBox _view = Combo("Moon beside the Earth", "Above my location", "Sunrise behind the Earth");
    private readonly NumericUpDown _lat = Num(-90, 90, 1);
    private readonly NumericUpDown _lon = Num(-180, 180, 1);
    private readonly TrackBar _fill = Track(50, 110);
    private readonly TrackBar _position = Track(-100, 100);
    private readonly TrackBar _sunside = Track(0, 90);
    private readonly ComboBox _moon = Combo("True size", "2×", "3×", "4×");
    private readonly CheckBox _clouds = Check("Live clouds");
    private readonly TrackBar _cloudOpacity = Track(20, 100);
    private readonly CheckBox _storms = Check("Label active storms (hurricanes, typhoons, cyclones)");
    private readonly CheckBox _labels = Check("Label the Moon and planets");
    private readonly CheckBox _credits = Check("Show credits (bottom right)");
    private readonly TrackBar _stars = Track(0, 100);
    private readonly TrackBar _milkyWay = Track(0, 100);
    private readonly TrackBar _exposure = Track(50, 200);
    private readonly ComboBox _quality = Combo("Low (integrated graphics)", "Medium", "High (8K textures)");
    private readonly ComboBox _fps = Combo("10", "15", "24", "30", "60");
    private readonly ComboBox _monitors = Combo("All monitors", "Primary monitor only");
    private readonly CheckBox _pauseCovered = Check("Pause when a maximised or full-screen app covers the desktop");
    private readonly CheckBox _pauseBattery = Check("Pause on battery power");
    private readonly NumericUpDown _refresh = Num(15, 720, 0);
    private readonly TextBox _cloudUrl = new() { Dock = DockStyle.Fill, PlaceholderText = "optional: URL of an equirectangular cloud map (JPG/PNG)" };
    private readonly CheckBox _autostart = Check("Start with Windows");
    private readonly Label _statusLabel = new() { AutoSize = true, ForeColor = SystemColors.GrayText, MaximumSize = new Size(560, 0) };

    public SettingsForm(AppSettings current, Action<AppSettings> apply, Func<string> status, Action refreshWeather)
    {
        _s = current.Clone();
        _apply = apply;
        _status = status;
        _refreshWeather = refreshWeather;

        Text = "3D Earth settings";
        Icon = TrayContext.AppIcon;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        Font = new Font("Segoe UI", 9f);

        var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 380));

        Header(grid, "View");
        Row(grid, "Camera", _view);
        var guess = new Button { Text = "Guess from time zone", AutoSize = true };
        guess.Click += (_, _) =>
        {
            var t = new AppSettings();
            t.GuessHomeFromTimeZone();
            _lat.Value = (decimal)t.HomeLat;
            _lon.Value = (decimal)t.HomeLon;
        };
        var loc = Flow(new Label { Text = "Lat", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 2, 0) }, _lat,
                       new Label { Text = "Lon", AutoSize = true, Margin = new Padding(8, 6, 2, 0) }, _lon, guess);
        Row(grid, "My location", loc);
        Row(grid, "Earth size (% of height)", _fill);
        Row(grid, "Earth position (left ↔ right)", _position);
        Row(grid, "Moon view: sunlit ↔ terminator", _sunside);
        Row(grid, "Moon size", _moon);

        Header(grid, "Weather");
        Row(grid, "", _clouds);
        Row(grid, "Cloud opacity", _cloudOpacity);
        Row(grid, "", _storms);
        Row(grid, "Update every (minutes)", _refresh);
        Row(grid, "Cloud map URL", _cloudUrl);

        Header(grid, "Sky");
        Row(grid, "", _labels);
        Row(grid, "", _credits);
        Row(grid, "Stars", _stars);
        Row(grid, "Milky Way", _milkyWay);
        Row(grid, "Brightness", _exposure);

        Header(grid, "Performance");
        Row(grid, "Quality", _quality);
        Row(grid, "Frame rate (fps)", _fps);
        Row(grid, "Show on", _monitors);
        Row(grid, "", _pauseCovered);
        Row(grid, "", _pauseBattery);
        Row(grid, "", _autostart);

        var refreshNow = new Button { Text = "Update weather now", AutoSize = true };
        refreshNow.Click += (_, _) => { _refreshWeather(); _statusLabel.Text = "Downloading…"; };
        var openData = new LinkLabel { Text = "Open data folder", AutoSize = true, Margin = new Padding(12, 8, 0, 0) };
        openData.LinkClicked += (_, _) => Process.Start(new ProcessStartInfo("explorer.exe", $"\"{Paths.Data}\"") { UseShellExecute = true });
        Header(grid, "Status");
        grid.Controls.Add(_statusLabel, 0, grid.RowCount);
        grid.SetColumnSpan(_statusLabel, 2);
        grid.RowCount++;
        var actions = Flow(refreshNow, openData);
        grid.Controls.Add(actions, 0, grid.RowCount);
        grid.SetColumnSpan(actions, 2);
        grid.RowCount++;

        var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, AutoSize = true, MinimumSize = new Size(80, 0) };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true, MinimumSize = new Size(80, 0) };
        var applyButton = new Button { Text = "Apply", AutoSize = true, MinimumSize = new Size(80, 0) };
        applyButton.Click += (_, _) => Commit();
        ok.Click += (_, _) => Commit();
        AcceptButton = ok;
        CancelButton = cancel;
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
        buttons.Controls.AddRange(new Control[] { cancel, ok, applyButton });
        grid.Controls.Add(buttons, 0, grid.RowCount);
        grid.SetColumnSpan(buttons, 2);
        grid.RowCount++;

        Controls.Add(grid);
        LoadValues();

        var timer = new System.Windows.Forms.Timer { Interval = 2000, Enabled = true };
        timer.Tick += (_, _) => _statusLabel.Text = _status();
        FormClosed += (_, _) => timer.Dispose();
        _statusLabel.Text = _status();
    }

    private void LoadValues()
    {
        _view.SelectedIndex = _s.View switch { "home" => 1, "sunrise" => 2, _ => 0 };
        _lat.Value = (decimal)Math.Clamp(_s.HomeLat, -90, 90);
        _lon.Value = (decimal)Math.Clamp(_s.HomeLon, -180, 180);
        _fill.Value = Clamp(_fill, (int)Math.Round(_s.EarthFill * 100));
        _position.Value = Clamp(_position, (int)Math.Round(_s.EarthPosition * 100));
        _sunside.Value = Clamp(_sunside, (int)Math.Round(_s.SunsideBias));
        _moon.SelectedIndex = Math.Clamp((int)Math.Round(_s.MoonScale) - 1, 0, 3);
        _clouds.Checked = _s.Clouds;
        _cloudOpacity.Value = Clamp(_cloudOpacity, (int)Math.Round(_s.CloudOpacity * 100));
        _storms.Checked = _s.Storms;
        _labels.Checked = _s.Labels;
        _credits.Checked = _s.Credits;
        _stars.Value = Clamp(_stars, (int)Math.Round(_s.Stars * 100));
        _milkyWay.Value = Clamp(_milkyWay, (int)Math.Round(_s.MilkyWay * 100));
        _exposure.Value = Clamp(_exposure, (int)Math.Round(_s.Exposure * 100));
        _quality.SelectedIndex = _s.Quality switch { "low" => 0, "high" => 2, _ => 1 };
        _fps.SelectedItem = _s.Fps.ToString(CultureInfo.InvariantCulture);
        if (_fps.SelectedIndex < 0) _fps.SelectedIndex = 3;
        _monitors.SelectedIndex = _s.Monitors == "primary" ? 1 : 0;
        _pauseCovered.Checked = _s.PauseWhenCovered;
        _pauseBattery.Checked = _s.PauseOnBattery;
        _refresh.Value = Math.Clamp(_s.WeatherRefreshMinutes, 15, 720);
        _cloudUrl.Text = _s.CustomCloudUrl;
        _autostart.Checked = StartupRegistration.IsEnabled;
    }

    private void Commit()
    {
        _s.View = _view.SelectedIndex switch { 1 => "home", 2 => "sunrise", _ => "moon" };
        _s.HomeLat = (double)_lat.Value;
        _s.HomeLon = (double)_lon.Value;
        _s.EarthFill = _fill.Value / 100.0;
        _s.EarthPosition = _position.Value / 100.0;
        _s.SunsideBias = _sunside.Value;
        _s.MoonScale = _moon.SelectedIndex + 1;
        _s.Clouds = _clouds.Checked;
        _s.CloudOpacity = _cloudOpacity.Value / 100.0;
        _s.Storms = _storms.Checked;
        _s.Labels = _labels.Checked;
        _s.Credits = _credits.Checked;
        _s.Stars = _stars.Value / 100.0;
        _s.MilkyWay = _milkyWay.Value / 100.0;
        _s.Exposure = _exposure.Value / 100.0;
        _s.Quality = _quality.SelectedIndex switch { 0 => "low", 2 => "high", _ => "medium" };
        _s.Fps = int.Parse((string)_fps.SelectedItem!, CultureInfo.InvariantCulture);
        _s.Monitors = _monitors.SelectedIndex == 1 ? "primary" : "all";
        _s.PauseWhenCovered = _pauseCovered.Checked;
        _s.PauseOnBattery = _pauseBattery.Checked;
        _s.WeatherRefreshMinutes = (int)_refresh.Value;
        _s.CustomCloudUrl = _cloudUrl.Text.Trim();
        StartupRegistration.Set(_autostart.Checked);
        _apply(_s.Clone());
    }

    // ---- small layout helpers ----
    private static ComboBox Combo(params string[] items)
    {
        var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240 };
        c.Items.AddRange(items);
        return c;
    }

    private static NumericUpDown Num(int min, int max, int decimals) =>
        new() { Minimum = min, Maximum = max, DecimalPlaces = decimals, Width = 70, Increment = decimals > 0 ? 0.5m : 5 };

    private static TrackBar Track(int min, int max) =>
        new() { Minimum = min, Maximum = max, TickStyle = TickStyle.None, Dock = DockStyle.Fill, AutoSize = false, Height = 28 };

    private static CheckBox Check(string text) => new() { Text = text, AutoSize = true };

    private static int Clamp(TrackBar t, int v) => Math.Clamp(v, t.Minimum, t.Maximum);

    private static FlowLayoutPanel Flow(params Control[] controls)
    {
        var f = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = Padding.Empty };
        f.Controls.AddRange(controls);
        return f;
    }

    private static void Header(TableLayoutPanel grid, string text)
    {
        var l = new Label
        {
            Text = text,
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 10f),
            Margin = new Padding(0, grid.RowCount == 0 ? 0 : 14, 0, 4),
        };
        grid.Controls.Add(l, 0, grid.RowCount);
        grid.SetColumnSpan(l, 2);
        grid.RowCount++;
    }

    private static void Row(TableLayoutPanel grid, string label, Control control)
    {
        grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 0) }, 0, grid.RowCount);
        control.Margin = new Padding(0, 3, 0, 3);
        grid.Controls.Add(control, 1, grid.RowCount);
        grid.RowCount++;
    }
}
