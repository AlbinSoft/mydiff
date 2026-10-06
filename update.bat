@echo off
rem Actualiza MyDiff a la ultima version de la rama main de GitHub.
rem Sobrescribe los ficheros del repo; connections.data.php y auth_config.php
rem no estan en el repo, asi que nunca se tocan.
rem
rem Requiere Windows 10 (1803) o superior: usa curl.exe y tar.exe del sistema.

setlocal

set "REPO_URL=https://github.com/AlbinSoft/mydiff/archive/refs/heads/main.zip"
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"
set "TMP_DIR=%TEMP%\mydiff-update-%RANDOM%%RANDOM%"

rem Rutas absolutas: si Git esta en el PATH, su tar (GNU) no entiende C:\...
set "CURL=%SystemRoot%\System32\curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"

if not exist "%APP_DIR%\api.php" (
    echo Error: no se encuentra api.php en %APP_DIR%. Esto no parece una instalacion de MyDiff.
    exit /b 1
)

mkdir "%TMP_DIR%" || exit /b 1

echo Descargando la ultima version...
"%CURL%" -fsSL -o "%TMP_DIR%\mydiff.zip" "%REPO_URL%"
if errorlevel 1 (
    echo Error: no se pudo descargar %REPO_URL%
    rd /s /q "%TMP_DIR%"
    exit /b 1
)

"%TAR%" -xf "%TMP_DIR%\mydiff.zip" -C "%TMP_DIR%"
if errorlevel 1 (
    echo Error: no se pudo descomprimir la descarga.
    rd /s /q "%TMP_DIR%"
    exit /b 1
)

rem El zip trae una unica carpeta raiz (mydiff-main)
set "SRC_DIR=%TMP_DIR%\mydiff-main"
if not exist "%SRC_DIR%\api.php" (
    echo Error: la descarga no contiene una version valida de MyDiff.
    rd /s /q "%TMP_DIR%"
    exit /b 1
)

echo Copiando ficheros en %APP_DIR%...

rem Este .bat se sobrescribe al copiar y cmd lo lee por trozos: el bloque entre
rem parentesis se analiza entero antes de ejecutarse, asi que no lee nada nuevo.
rem robocopy devuelve menos de 8 cuando todo va bien.
(
    robocopy "%SRC_DIR%" "%APP_DIR%" /E /NFL /NDL /NJH /NJS /NP >nul
    if errorlevel 8 (
        echo Error: fallo al copiar los ficheros.
        rd /s /q "%TMP_DIR%"
        exit /b 1
    )
    rd /s /q "%TMP_DIR%"
    echo MyDiff actualizado correctamente.
    exit /b 0
)
