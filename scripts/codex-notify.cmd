@echo off
setlocal
"%~dp0plugin\runtime\node.exe" "%~dp0dist\src\runtime\cli.js" %*
exit /b %errorlevel%
