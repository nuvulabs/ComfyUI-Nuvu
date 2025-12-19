@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
set "URL=https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
set "ARCHIVE_NAME=ComfyUI_windows_portable_nvidia.7z"
set "EXTRACT_DIR=ComfyUI_windows_portable"
set "NUVU_REPO=https://github.com/nuvulabs/ComfyUI-Nuvu.git"

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
echo ========================================================
echo   Installation Complete!
echo ========================================================
echo.
echo You can now run ComfyUI by opening the folder:
echo "%ROOT_DIR%%EXTRACT_DIR%"
echo.
echo And running: run_nvidia_gpu.bat
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
    "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location -r requirements.txt
    if errorlevel 1 (
        echo [WARNING] Failed to install requirements.txt for %NODE_DIR%.
    )
    popd
) else if exist "%NODE_DIR%\req.txt" (
    echo Installing req.txt for %NODE_DIR%...
    pushd "%NODE_DIR%"
    "%PYTHON_EXE%" -s -m pip install -q --no-warn-script-location -r req.txt
    if errorlevel 1 (
        echo [WARNING] Failed to install req.txt for %NODE_DIR%.
    )
    popd
)

exit /b 0
