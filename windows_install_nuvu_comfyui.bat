@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

set "INSTALL_LOG=%ROOT_DIR%install.log"
type nul > "%INSTALL_LOG%"

set "COMFY_DIR=%ROOT_DIR%ComfyUI"
set "RUN_SCRIPT_NAME=run_comfy.bat"
set "COMFY_PORT=8188"
set "nuvu_COMPILED_REPO=https://github.com/nuvulabs/ComfyUI-Nuvu.git"

REM UV install location (same as prestartup_script.py)
set "UV_DIR=%LOCALAPPDATA%\nuvu\bin"
set "UV_EXE=%UV_DIR%\uv.exe"
set "USE_UV=0"

REM Verbose mode - set to 1 to show all output, 0 to redirect to log file
set "VERBOSE=0"

REM Parse command line arguments
:parse_args
if "%~1"=="" goto :done_args
if /i "%~1"=="--verbose" set "VERBOSE=1" & shift & goto :parse_args
if /i "%~1"=="-v" set "VERBOSE=1" & shift & goto :parse_args
shift
goto :parse_args
:done_args

echo.
echo ========================================================
echo   ComfyUI + Nuvu Installer
echo ========================================================
if "%VERBOSE%"=="1" echo   [VERBOSE MODE ENABLED]
echo.
echo === Checking for Python 3.12 ===
if "%VERBOSE%"=="1" (
    py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info>=(3,12) else 1)"
) else (
    py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info>=(3,12) else 1)" >> "%INSTALL_LOG%" 2>&1
)
if errorlevel 1 (
    echo Python 3.12 not detected. Attempting install via winget...
    if "%VERBOSE%"=="1" (
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    ) else (
        winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to install Python 3.12 via winget. Please install Python 3.12 manually and re-run this script.
        exit /b 1
    )
)

echo.
echo === Checking for git ===
if "%VERBOSE%"=="1" (
    git --version
) else (
    git --version >> "%INSTALL_LOG%" 2>&1
)
if errorlevel 1 (
    echo Git was not found. Please install Git for Windows and re-run this script.
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
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '!UV_ZIP!'" >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to download uv, will use pip instead.
        goto :skip_uv
    )
    echo Extracting uv...
    if "%VERBOSE%"=="1" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('!UV_ZIP!'); foreach ($entry in $zip.Entries) { if ($entry.Name -eq 'uv.exe') { $dest = '%UV_EXE%'; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true); break } }; $zip.Dispose()"
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('!UV_ZIP!'); foreach ($entry in $zip.Entries) { if ($entry.Name -eq 'uv.exe') { $dest = '%UV_EXE%'; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true); break } }; $zip.Dispose()" >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to extract uv, will use pip instead.
        goto :skip_uv
    )
    del /q "!UV_ZIP!" 2>nul
    if exist "%UV_EXE%" (
        echo uv installed successfully to %UV_EXE%
        set "USE_UV=1"
    ) else (
        echo uv installation failed, will use pip instead.
    )
)
:skip_uv

echo.
echo === Preparing ComfyUI directory ===
if not exist "%COMFY_DIR%" (
    echo Cloning ComfyUI...
    if "%VERBOSE%"=="1" (
        git clone https://github.com/Comfy-Org/ComfyUI.git "%COMFY_DIR%"
    ) else (
        git clone -q https://github.com/Comfy-Org/ComfyUI.git "%COMFY_DIR%" >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to clone ComfyUI.
        exit /b 1
    )
) else (
    echo ComfyUI folder already exists at "%COMFY_DIR%". Skipping clone.
)

cd /d "%COMFY_DIR%"

echo.
echo === Creating virtual environment ===
if not exist "venv" (
    if "%VERBOSE%"=="1" (
        py -3.12 -m venv venv
    ) else (
        py -3.12 -m venv venv >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to create Python 3.12 virtual environment.
        exit /b 1
    )
) else (
    echo venv already exists. Skipping creation.
)

if "%VERBOSE%"=="1" (
    call "venv\Scripts\activate.bat"
) else (
    call "venv\Scripts\activate.bat" >> "%INSTALL_LOG%" 2>&1
)
if errorlevel 1 (
    echo Failed to activate the virtual environment.
    exit /b 1
)

echo.
echo === Upgrading pip ===
if "%VERBOSE%"=="1" (
    python -m pip install --no-warn-script-location --upgrade pip
) else (
    python -m pip install -q --no-warn-script-location --upgrade pip >> "%INSTALL_LOG%" 2>&1
)
if errorlevel 1 (
    echo Failed to upgrade pip.
    exit /b 1
)

REM Display which package manager will be used
if "%USE_UV%"=="1" (
    echo Using uv for fast package installation
) else (
    echo Using pip for package installation
)

echo.
echo === Installing PyTorch 2.9.1 stack, this will take up to 10 minutes ===
call :pkg_install torch==2.9.1 torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130
if errorlevel 1 (
    echo Failed to install PyTorch 2.9.1 stack.
    exit /b 1
)

echo.
echo === Installing core ComfyUI dependencies ===
call :pkg_install_req requirements.txt --extra-index-url https://download.pytorch.org/whl/cu130
if errorlevel 1 (
    echo Failed to install ComfyUI requirements.
    exit /b 1
)

call :pkg_install "triton-windows<3.6"
if errorlevel 1 (
    echo Failed to install Triton Windows build.
    exit /b 1
)

call :pkg_install https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post4/sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl
if errorlevel 1 (
    echo Failed to install SageAttention wheel.
    exit /b 1
)

cd /d "%COMFY_DIR%"
if not exist "custom_nodes" mkdir "custom_nodes"
cd /d "%COMFY_DIR%\custom_nodes"

echo.
echo === Installing core custom nodes, some may take a few minutes to install ===
call :clone_and_install "ComfyUI-Manager" "https://github.com/Comfy-Org/ComfyUI-Manager.git"
call :clone_and_install "ComfyUI-Nuvu" "%nuvu_COMPILED_REPO%"
call :clone_and_install "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
call :clone_and_install "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
call :clone_and_install "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
call :clone_and_install "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"
call :clone_and_install "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
call :clone_and_install "ComfyUI-Impact-Pack" "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"

cd /d "%COMFY_DIR%"

echo.
echo === Creating helper launcher: %RUN_SCRIPT_NAME% ===
> "%COMFY_DIR%\%RUN_SCRIPT_NAME%" (
    echo @echo off
    echo setlocal EnableExtensions
    echo cd /d "%%~dp0"
    echo call "%%~dp0venv\Scripts\activate.bat"
    echo python main.py --port %COMFY_PORT% --use-sage-attention --preview-method auto --auto-launch
)
if errorlevel 1 (
    echo Failed to create "%RUN_SCRIPT_NAME%".
    exit /b 1
)

echo.
echo === Creating shortcuts ===
set "SHORTCUT_NAME=Nuvu-ComfyUI"
set "ICON_PATH=%COMFY_DIR%\custom_nodes\ComfyUI-Nuvu\web\images\favicon.ico"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP=%USERPROFILE%\Desktop"

REM Create Start Menu shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%START_MENU%\%SHORTCUT_NAME%.lnk'); $s.TargetPath = '%COMFY_DIR%\%RUN_SCRIPT_NAME%'; $s.WorkingDirectory = '%COMFY_DIR%'; $s.IconLocation = '%ICON_PATH%,0'; $s.Description = 'Launch Nuvu-ComfyUI'; $s.Save()" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to create Start Menu shortcut. >> "%INSTALL_LOG%" 2>&1
) else (
    echo Created Start Menu shortcut: "%START_MENU%\%SHORTCUT_NAME%.lnk"
)

REM Create Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP%\%SHORTCUT_NAME%.lnk'); $s.TargetPath = '%COMFY_DIR%\%RUN_SCRIPT_NAME%'; $s.WorkingDirectory = '%COMFY_DIR%'; $s.IconLocation = '%ICON_PATH%,0'; $s.Description = 'Launch Nuvu-ComfyUI'; $s.Save()" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to create Desktop shortcut. >> "%INSTALL_LOG%" 2>&1
) else (
    echo Created Desktop shortcut: "%DESKTOP%\%SHORTCUT_NAME%.lnk"
)

echo.
echo All done! Use "%COMFY_DIR%\%RUN_SCRIPT_NAME%" to launch ComfyUI with ComfyUI-Nuvu.
echo You can also find "Nuvu-ComfyUI" in your Start Menu and on your Desktop.
echo If you run into issues, check: "%INSTALL_LOG%"
pause
exit /b 0

:clone_and_install
set "NODE_DIR=%~1"
set "NODE_REPO=%~2"
echo Installing %NODE_DIR% custom node...
if not exist "%NODE_DIR%" (
    if "%VERBOSE%"=="1" (
        git clone "%NODE_REPO%"
    ) else (
        git clone -q "%NODE_REPO%" >> "%INSTALL_LOG%" 2>&1
    )
    if errorlevel 1 (
        echo Failed to clone %NODE_DIR%.
        exit /b 1
    )
) else (
    if "%VERBOSE%"=="1" (
        echo %NODE_DIR% already present. Skipping clone.
    ) else (
        echo %NODE_DIR% already present. Skipping clone. >> "%INSTALL_LOG%" 2>&1
    )
)

REM Install dependency requirements if present
if exist "%NODE_DIR%\requirements.txt" (
    pushd "%NODE_DIR%"
    call :pkg_install_req requirements.txt
    if errorlevel 1 (
        echo Failed to install requirements.txt for %NODE_DIR%.
        popd
        exit /b 1
    )
    popd
)

exit /b 0

REM ============================================================
REM Package installation helpers - use uv if available, else pip
REM ============================================================

:pkg_install
REM Install packages using uv (if available) or pip
REM Usage: call :pkg_install package1 package2 --extra-args
if "%VERBOSE%"=="1" (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install %*
    ) else (
        python -m pip install --no-warn-script-location %*
    )
) else (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --quiet %* >> "%INSTALL_LOG%" 2>&1
    ) else (
        python -m pip install -q --no-warn-script-location %* >> "%INSTALL_LOG%" 2>&1
    )
)
exit /b %errorlevel%

:pkg_install_req
REM Install from requirements file using uv (if available) or pip
REM Usage: call :pkg_install_req requirements.txt [--extra-args]
set "REQ_FILE=%~1"
shift
if "%VERBOSE%"=="1" (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install -r "%REQ_FILE%" %1 %2 %3 %4 %5
    ) else (
        python -m pip install --no-warn-script-location -r "%REQ_FILE%" %1 %2 %3 %4 %5
    )
) else (
    if "%USE_UV%"=="1" (
        "%UV_EXE%" pip install --quiet -r "%REQ_FILE%" %1 %2 %3 %4 %5 >> "%INSTALL_LOG%" 2>&1
    ) else (
        python -m pip install -q --no-warn-script-location -r "%REQ_FILE%" %1 %2 %3 %4 %5 >> "%INSTALL_LOG%" 2>&1
    )
)
exit /b %errorlevel%