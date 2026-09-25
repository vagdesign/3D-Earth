; Inno Setup script for 3D Earth (per-user install, no administrator rights needed).
; Built by .github/workflows/build.yml:  ISCC /DAppVersion=x.y.z /DSourceDir=..\publish installer\3DEarth.iss

#define AppName "3D Earth"
#define AppExe "3DEarth.exe"
#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\publish"
#endif

[Setup]
AppId={{8C3F1E52-4B7A-4D0E-9E6B-3D5A0E1A2B7C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Ax-Easy (Vangelis Makridakis)
AppPublisherURL=https://www.ax-easy.com
DefaultDirName={localappdata}\Programs\3D Earth
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=3DEarth-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
SetupIconFile=..\src\ThreeDEarth\Earth.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
CloseApplications=no

[Tasks]
Name: "autostart"; Description: "Start 3D Earth automatically when I sign in to Windows"; GroupDescription: "Startup:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\3D Earth"; Filename: "{app}\{#AppExe}"
Name: "{autoprograms}\3D Earth Settings"; Filename: "{app}\{#AppExe}"; Parameters: "--settings"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "3D Earth"; ValueData: """{app}\{#AppExe}"" --autostart"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start 3D Earth now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "Stop3DEarth"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\3D Earth"

[Code]
function WebView2Installed(): Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not WebView2Installed() then
  begin
    if MsgBox('3D Earth needs the Microsoft Edge WebView2 Runtime, which was not found on this PC.' + #13#10#13#10 +
              'Open the download page now? You can continue the installation either way.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;

// Stop a running copy so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// The app can also add itself to "Run" from its menu; remove that entry too.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', '3D Earth');
end;
