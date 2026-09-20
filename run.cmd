@echo off
rem Запуск Twonky Grabber в Docker.
rem Скачанные файлы и состояние монтируются из каталогов downloads и data
rem (bind volume) — они остаются на хосте и переживают пересоздание контейнера.
setlocal

set IMAGE=twonky-grabber
set PORT=3000
set SCRIPT_DIR=%~dp0

if not exist "%SCRIPT_DIR%downloads" mkdir "%SCRIPT_DIR%downloads"
if not exist "%SCRIPT_DIR%data" mkdir "%SCRIPT_DIR%data"

docker image inspect %IMAGE% >nul 2>&1
if errorlevel 1 (
    echo Образ %IMAGE% не найден — собираю...
    docker build -t %IMAGE% "%SCRIPT_DIR%"
    if errorlevel 1 exit /b 1
)

echo Запуск %IMAGE% на http://localhost:%PORT%
echo Загрузки: %SCRIPT_DIR%downloads
echo Состояние: %SCRIPT_DIR%data

docker run --rm -p %PORT%:3000 -v "%SCRIPT_DIR%downloads:/app/server/downloads" -v "%SCRIPT_DIR%data:/app/server/data" %IMAGE%
