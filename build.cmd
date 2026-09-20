@echo off
rem Сборка Docker-образа Twonky Grabber.
setlocal

set IMAGE=twonky-grabber
set SCRIPT_DIR=%~dp0

docker build -t %IMAGE% "%SCRIPT_DIR%"
if errorlevel 1 exit /b 1

echo Образ %IMAGE% собран.
