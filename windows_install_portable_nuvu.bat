@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
set "URL=https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
set "ARCHIVE_NAME=ComfyUI_windows_portable_nvidia.7z"
set "EXTRACT_DIR=ComfyUI_windows_portable"
set "NUVU_REPO=https://github.com/nuvulabs/ComfyUI-Nuvu.git"

REM UV install location (same as prestartup_script.py)
set "UV_DIR=%LOCALAPPDATA%\nuvu\bin"
set "UV_EXE=%UV_DIR%\uv.exe"
set "USE_UV=0"

echo ========================================================
echo   ComfyUI Portable + Nuvu Auto-Installer
echo ========================================================
echo.

if exist "%EXTRACT_DIR%" (
    echo Folder "%EXTRACT_DIR%" already exists.
    echo Skipping download and extraction to prevent overwriting.
) else (
    if not exist "%ARCHIVE_NAME%" (
        echo Downloading ComfyUI Portable from:
        echo %URL%
        echo.
        curl -L -o "%ARCHIVE_NAME%" "%URL%"
        if errorlevel 1 (
            echo.
            echo [ERROR] Download failed. Please check your internet connection.
            pause
            exit /b 1
        )
    )

    echo.
    echo Extracting %ARCHIVE_NAME%...
    echo This may take a few minutes. Please wait...
    
    REM Try using native tar (Windows 10/11)
    echo Attempting extraction with native tar...
    tar -xf "%ARCHIVE_NAME%"
    
    if errorlevel 1 (
        echo.
        echo [WARNING] Native extraction failed. Attempting fallback to 7-Zip...
        
        echo Downloading 7-Zip standalone tool...
        curl -L -o 7zr.exe "https://www.7-zip.org/a/7zr.exe"
        if errorlevel 1 (
            echo.
            echo [ERROR] Failed to download 7zr.exe.
            pause
            exit /b 1
        )
        
        echo Extracting with 7-Zip...
        7zr.exe x "%ARCHIVE_NAME%" -y
        if errorlevel 1 (
            echo.
            echo [ERROR] 7-Zip extraction also failed.
            if exist 7zr.exe del 7zr.exe
            pause
            exit /b 1
        )
        
        echo Cleaning up 7-Zip...
        if exist 7zr.exe del 7zr.exe
    )
)

echo.
echo ========================================================
echo   Installing Custom Nodes
echo ========================================================
echo.

set "CUSTOM_NODES_DIR=%EXTRACT_DIR%\ComfyUI\custom_nodes"
if not exist "%CUSTOM_NODES_DIR%" (
    echo [ERROR] Custom nodes directory not found at:
    echo %CUSTOM_NODES_DIR%
    echo.
    echo The extraction might have failed or the folder structure changed.
    pause
    exit /b 1
)

REM Define Python executable path for the helper function
set "PYTHON_EXE=%ROOT_DIR%%EXTRACT_DIR%\python_embeded\python.exe"

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python embedded not found at:
    echo %PYTHON_EXE%
    pause
    exit /b 1
)

echo.
echo === Installing uv (fast package installer) ===
if exist "%UV_EXE%" (
    echo uv already installed at %UV_EXE%
    set "USE_UV=1"
) else (
    echo Downloading uv...
    if not exist "%UV_DIR%" mkdir "%UV_DIR%"
    set "UV_ZIP=%TEMP%\uv-download.zip"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '!UV_ZIP!'" 2>nul
    if errorlevel 1 (
        echo Failed to download uv, will use pip instead.
        goto :skip_uv_portable
    )
    echo Extracting uv...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('!UV_ZIP!'); foreach ($entry in $zip.Entries) { if ($entry.Name -eq 'uv.exe') { $dest = '%UV_EXE%'; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true); break } }; $zip.Dispose()" 2>nul
    if errorlevel 1 (
        echo Failed to extract uv, will use pip instead.
        goto :skip_uv_portable
    )
    del /q "!UV_ZIP!" 2>nul
    if exist "%UV_EXE%" (
        echo uv installed successfully to %UV_EXE%
        set "USE_UV=1"
    ) else (
        echo uv installation failed, will use pip instead.
    )
)
:skip_uv_portable

REM Display which package manager will be used
if "%USE_UV%"=="1" (
    echo Using uv for fast package installation
) else (
    echo Using pip for package installation
)

cd /d "%CUSTOM_NODES_DIR%"

echo.
echo === Installing core custom nodes ===
call :clone_and_install "ComfyUI-Manager" "https://github.com/Comfy-Org/ComfyUI-Manager.git"
call :clone_and_install "ComfyUI-Nuvu" "%NUVU_REPO%"
call :clone_and_install "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
call :clone_and_install "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
call :clone_and_install "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
call :clone_and_install "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"
call :clone_and_install "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
call :clone_and_install "ComfyUI-Impact-Pack" "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"


cd /d "%ROOT_DIR%"

set "PORTABLE_DIR=%ROOT_DIR%%EXTRACT_DIR%"
set "RUN_SCRIPT=%PORTABLE_DIR%\run_nvidia_gpu.bat"

echo.
echo === Updating launcher with Nuvu options ===
> "%RUN_SCRIPT%" (
    echo .\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --use-sage-attention --preview-method auto --auto-launch
    echo pause
)

echo.
echo === Creating shortcuts ===
set "SHORTCUT_NAME=Nuvu-ComfyUI"
set "ICON_PATH=%PORTABLE_DIR%\ComfyUI\custom_nodes\ComfyUI-Nuvu\web\images\favicon.ico"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP=%USERPROFILE%\Desktop"

REM Create Start Menu shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%START_MENU%\%SHORTCUT_NAME%.lnk'); $s.TargetPath = '%RUN_SCRIPT%'; $s.WorkingDirectory = '%PORTABLE_DIR%'; $s.IconLocation = '%ICON_PATH%,0'; $s.Description = 'Launch Nuvu-ComfyUI'; $s.Save()"
if errorlevel 1 (
    echo Failed to create Start Menu shortcut.
) else (
    echo Created Start Menu shortcut: "%START_MENU%\%SHORTCUT_NAME%.lnk"
)

REM Create Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP%\%SHORTCUT_NAME%.lnk'); $s.TargetPath = '%RUN_SCRIPT%'; $s.WorkingDirectory = '%PORTABLE_DIR%'; $s.IconLocation = '%ICON_PATH%,0'; $s.Description = 'Launch Nuvu-ComfyUI'; $s.Save()"
if errorlevel 1 (
    echo Failed to create Desktop shortcut.
) else (
    echo Created Desktop shortcut: "%DESKTOP%\%SHORTCUT_NAME%.lnk"
)

echo.
echo ========================================================
echo   Installation Complete!
echo ========================================================
echo.
echo You can now run ComfyUI by opening the folder:
echo "%PORTABLE_DIR%"
echo.
echo And running: run_nvidia_gpu.bat
echo.
echo You can also find "Nuvu-ComfyUI" in your Start Menu and on your Desktop.
echo.
pause
exit /b 0

:clone_and_install
set "NODE_DIR=%~1"
set "NODE_REPO=%~2"
echo.
echo Installing %NODE_DIR%...
if not exist "%NODE_DIR%" (
    git clone -q "%NODE_REPO%" "%NODE_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to clone %NODE_DIR%.
        exit /b 1
    )
) else (
    echo %NODE_DIR% already present. Pulling latest...
    pushd "%NODE_DIR%"
    git pull
    popd
)

REM Install dependency requirements if present
if exist "%NODE_DIR%\requirements.txt" (
    echo Installing requirements for %NODE_DIR%...
    pushd "%NODE_DIR%"
    call :pkg_install_req_portable requirements.txt
    if errorlevel 1 (
        echo [WARNING] Failed to install requirements.txt for %NODE_DIR%.
    )
    popd
) else if exist "%NODE_DIR%\req.txt" (
    echo Installing req.txt for %NODE_DIR%...
    pushd "%NODE_DIR%"
    call :pkg_install_req_portable req.txt
    if errorlevel 1 (
        echo [WARNING] Failed to install req.txt for %NODE_DIR%.
    )
    popd
)

exit /b 0

REM ============================================================
REM Package installation helpers for portable - use uv if available, else pip
REM ============================================================

:pkg_install_portable
REM Install packages using uv (if available) or pip
REM Usage: call :pkg_install_portable package1 package2 --extra-args
if "%USE_UV%"=="1" (
    "%UV_EXE%" pip install --python "%PYTHON_EXE%" --quiet %*
) else (
    "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location %*
)
exit /b %errorlevel%

:pkg_install_req_portable
REM Install from requirements file using uv (if available) or pip
REM Usage: call :pkg_install_req_portable requirements.txt
set "REQ_FILE=%~1"
if "%USE_UV%"=="1" (
    "%UV_EXE%" pip install --python "%PYTHON_EXE%" --quiet -r "%REQ_FILE%"
) else (
    "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location -r "%REQ_FILE%"
)
exit /b %errorlevel%
