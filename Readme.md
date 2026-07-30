https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-win64.zip -- Download this

Run the below commands after 

$zip = "$env:USERPROFILE\Downloads\chrome-win64.zip"
$dest = "$env:LOCALAPPDATA\ms-playwright\chromium-1234"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
New-Item -ItemType File -Force -Path "$dest\INSTALLATION_COMPLETE" | Out-Null
