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

echo.
echo === Checking for Python 3.12 ===
py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info>=(3,12) else 1)" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Python 3.12 not detected. Attempting install via winget...
    winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to install Python 3.12 via winget. Please install Python 3.12 manually and re-run this script.
        exit /b 1
    )
)

echo.
echo === Checking for git ===
git --version >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Git was not found. Please install Git for Windows and re-run this script.
    exit /b 1
)

echo.
echo === Preparing ComfyUI directory ===
if not exist "%COMFY_DIR%" (
    echo Cloning ComfyUI...
    git clone -q https://github.com/comfyanonymous/ComfyUI.git "%COMFY_DIR%" >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to clone ComfyUI.
        exit /b 1
    )
) else (
    echo ComfyUI folder already exists at "%COMFY_DIR%". Skipping clone. >> "%INSTALL_LOG%" 2>&1
)

cd /d "%COMFY_DIR%"

echo.
echo === Creating virtual environment ===
if not exist "venv" (
    py -3.12 -m venv venv >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to create Python 3.12 virtual environment.
        exit /b 1
    )
) else (
    echo venv already exists. Skipping creation. >> "%INSTALL_LOG%" 2>&1
)

call "venv\Scripts\activate.bat" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to activate the virtual environment.
    exit /b 1
)

echo.
echo === Upgrading pip ===
python -m pip install -q --no-warn-script-location --upgrade pip >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to upgrade pip.
    exit /b 1
)

echo.
echo === Installing PyTorch 2.8.0 stack, this will take up to 10 minutes ===
python -m pip install -q --no-warn-script-location torch==2.8.0 torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu128 >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to install PyTorch 2.8.0 stack.
    exit /b 1
)

echo.
echo === Installing core ComfyUI dependencies ===
python -m pip install -q --no-warn-script-location -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu128 >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to install ComfyUI requirements.
    exit /b 1
)

python -m pip install -q --no-warn-script-location -U "triton-windows<3.5" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to install Triton Windows build.
    exit /b 1
)

python -m pip install -q --no-warn-script-location https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post2/sageattention-2.2.0+cu128torch2.8.0.post2-cp39-abi3-win_amd64.whl >> "%INSTALL_LOG%" 2>&1
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
echo === Copying icon file ===
set "ICON_SRC=%ROOT_DIR%web\images\favicon.ico"
set "ICON_DEST=%COMFY_DIR%\nuvu.ico"
if exist "%ICON_SRC%" (
    copy /Y "%ICON_SRC%" "%ICON_DEST%" >> "%INSTALL_LOG%" 2>&1
) else (
    echo Icon file not found at "%ICON_SRC%". Skipping icon copy. >> "%INSTALL_LOG%" 2>&1
)

echo.
echo === Creating shortcuts ===
set "SHORTCUT_NAME=Nuvu-ComfyUI"
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "DESKTOP=%USERPROFILE%\Desktop"

REM Create Start Menu shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; ^
    $s = $ws.CreateShortcut('%START_MENU%\%SHORTCUT_NAME%.lnk'); ^
    $s.TargetPath = '%COMFY_DIR%\%RUN_SCRIPT_NAME%'; ^
    $s.WorkingDirectory = '%COMFY_DIR%'; ^
    $s.IconLocation = '%ICON_DEST%,0'; ^
    $s.Description = 'Launch Nuvu-ComfyUI'; ^
    $s.Save()" >> "%INSTALL_LOG%" 2>&1
if errorlevel 1 (
    echo Failed to create Start Menu shortcut. >> "%INSTALL_LOG%" 2>&1
) else (
    echo Created Start Menu shortcut: "%START_MENU%\%SHORTCUT_NAME%.lnk"
)

REM Create Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; ^
    $s = $ws.CreateShortcut('%DESKTOP%\%SHORTCUT_NAME%.lnk'); ^
    $s.TargetPath = '%COMFY_DIR%\%RUN_SCRIPT_NAME%'; ^
    $s.WorkingDirectory = '%COMFY_DIR%'; ^
    $s.IconLocation = '%ICON_DEST%,0'; ^
    $s.Description = 'Launch Nuvu-ComfyUI'; ^
    $s.Save()" >> "%INSTALL_LOG%" 2>&1
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
    git clone -q "%NODE_REPO%" >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to clone %NODE_DIR%.
        exit /b 1
    )
) else (
    echo %NODE_DIR% already present. Skipping clone. >> "%INSTALL_LOG%" 2>&1
)

REM Install dependency requirements if present
if exist "%NODE_DIR%\requirements.txt" (
    pushd "%NODE_DIR%"
    python -m pip install -q --no-warn-script-location -r requirements.txt >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to install requirements.txt for %NODE_DIR%.
        popd
        exit /b 1
    )
    popd
) else if exist "%NODE_DIR%\req.txt" (
    pushd "%NODE_DIR%"
    python -m pip install -q --no-warn-script-location -r req.txt >> "%INSTALL_LOG%" 2>&1
    if errorlevel 1 (
        echo Failed to install req.txt for %NODE_DIR%.
        popd
        exit /b 1
    )
    popd
)

exit /b 0

