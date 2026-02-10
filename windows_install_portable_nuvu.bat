@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
set "URL=https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
set "ARCHIVE_NAME=ComfyUI_windows_portable_nvidia.7z"
set "EXTRACT_DIR=ComfyUI_windows_portable"
set "NUVU_REPO=https://github.com/nuvulabs/ComfyUI-Nuvu.git"

REM Ensure common Windows paths are available for tooling
if exist "%windir%\System32" set "PATH=%PATH%;%windir%\System32"
if exist "%windir%\System32\WindowsPowerShell\v1.0" set "PATH=%PATH%;%windir%\System32\WindowsPowerShell\v1.0"
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps" set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WindowsApps"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
if exist "%ProgramFiles%\Git\bin\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\bin"
if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles(x86)%\Git\cmd"
if exist "%ProgramFiles(x86)%\Git\bin\git.exe" set "PATH=%PATH%;%ProgramFiles(x86)%\Git\bin"

REM UV install location (same as prestartup_script.py)
set "UV_DIR=%LOCALAPPDATA%\nuvu\bin"
set "UV_EXE=%UV_DIR%\uv.exe"
set "USE_UV=0"

REM Verbose mode - set to 1 to show all output, 0 to hide
set "VERBOSE=0"

REM Parse command line arguments
:parse_args
if "%~1"=="" goto :done_args
if /i "%~1"=="--verbose" set "VERBOSE=1" & shift & goto :parse_args
if /i "%~1"=="-v" set "VERBOSE=1" & shift & goto :parse_args
shift
goto :parse_args
:done_args

echo ========================================================
echo   ComfyUI Portable + Nuvu Auto-Installer
echo ========================================================
if "%VERBOSE%"=="1" echo   [VERBOSE MODE ENABLED]
echo.

call :ensure_git
if errorlevel 1 (
    exit /b 1
)

if exist "%EXTRACT_DIR%" (
    echo Folder "%EXTRACT_DIR%" already exists.
    echo Skipping download and extraction to prevent overwriting.
) else (
    if not exist "%ARCHIVE_NAME%" (
        echo Downloading ComfyUI Portable from:
        echo %URL%
        echo.
        call :download_file "%URL%" "%ARCHIVE_NAME%"
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
        call :download_file "https://www.7-zip.org/a/7zr.exe" "7zr.exe"
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
    
    echo.
    echo Cleaning up downloaded archive...
    if exist "%ARCHIVE_NAME%" del "%ARCHIVE_NAME%"
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
    if "%VERBOSE%"=="1" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '!UV_ZIP!'"
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '!UV_ZIP!'" 2>nul
    )
    if errorlevel 1 (
        echo Failed to download uv, will use pip instead.
        goto :skip_uv_portable
    )
    echo Extracting uv...
    if "%VERBOSE%"=="1" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('!UV_ZIP!'); foreach ($entry in $zip.Entries) { if ($entry.Name -eq 'uv.exe') { $dest = '%UV_EXE%'; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true); break } }; $zip.Dispose()"
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('!UV_ZIP!'); foreach ($entry in $zip.Entries) { if ($entry.Name -eq 'uv.exe') { $dest = '%UV_EXE%'; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true); break } }; $zip.Dispose()" 2>nul
    )
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

echo.
echo === Installing Triton ===
call :pkg_install_portable "triton-windows<3.6"
if errorlevel 1 (
    echo [WARNING] Failed to install Triton.
)

echo.
echo === Installing SageAttention ===
call :pkg_install_portable https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post4/sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl
if errorlevel 1 (
    echo [WARNING] Failed to install SageAttention wheel.
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

echo.
echo === Installing ML dependencies ===
call :pkg_install_portable "transformers==4.57.6"
if errorlevel 1 (
    echo [WARNING] Failed to install Transformers.
)

call :pkg_install_portable "diffusers>=0.33.0"
if errorlevel 1 (
    echo [WARNING] Failed to install Diffusers.
)

call :pkg_install_portable "huggingface_hub<1.0"
if errorlevel 1 (
    echo [WARNING] Failed to install HuggingFace Hub.
)

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

REM ============================================================
REM Download helper
REM ============================================================

:download_file
set "DL_URL=%~1"
set "DL_OUT=%~2"
if "%VERBOSE%"=="1" (
    where curl.exe
) else (
    where curl.exe >nul 2>&1
)
if not errorlevel 1 (
    curl -L -o "%DL_OUT%" "%DL_URL%"
    exit /b %errorlevel%
)
if "%VERBOSE%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%DL_OUT%'"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%DL_OUT%'" 2>nul
)
exit /b %errorlevel%

REM ============================================================
REM Git availability helper
REM ============================================================

:ensure_git
if "%VERBOSE%"=="1" (
    git --version
) else (
    git --version >nul 2>&1
)
if errorlevel 1 (
    echo [ERROR] Git was not found. Please install Git for Windows and re-run this script.
    exit /b 1
)
exit /b 0

:clone_and_install
set "NODE_DIR=%~1"
set "NODE_REPO=%~2"
echo.
echo Installing %NODE_DIR%...
if not exist "%NODE_DIR%" (
    if "%VERBOSE%"=="1" (
        git clone "%NODE_REPO%" "%NODE_DIR%"
    ) else (
        git clone -q "%NODE_REPO%" "%NODE_DIR%"
    )
    if errorlevel 1 (
        echo [ERROR] Failed to clone %NODE_DIR%.
        exit /b 1
    )
) else (
    echo %NODE_DIR% already present. Pulling latest...
    pushd "%NODE_DIR%"
    if "%VERBOSE%"=="1" (
        git pull
    ) else (
        git pull -q
    )
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
if "%VERBOSE%"=="1" (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --python "%PYTHON_EXE%" %*
    ) else (
        "%PYTHON_EXE%" -s -m pip install --no-warn-script-location %*
    )
) else (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --python "%PYTHON_EXE%" --quiet %*
    ) else (
        "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location %*
    )
)
exit /b %errorlevel%

:pkg_install_req_portable
REM Install from requirements file using uv (if available) or pip
REM Usage: call :pkg_install_req_portable requirements.txt
set "REQ_FILE=%~1"
if "%VERBOSE%"=="1" (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --python "%PYTHON_EXE%" -r "%REQ_FILE%"
    ) else (
        "%PYTHON_EXE%" -s -m pip install --no-warn-script-location -r "%REQ_FILE%"
    )
) else (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --python "%PYTHON_EXE%" --quiet -r "%REQ_FILE%"
    ) else (
        "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location -r "%REQ_FILE%"
    )
)
exit /b %errorlevel%
