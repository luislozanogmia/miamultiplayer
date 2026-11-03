@echo off
rem Mia's handle on the Mia app; see ..\miaos-app-cli.py.
if "%HERMES_PYTHON%"=="" (set "MIA_APP_PY=python") else (set "MIA_APP_PY=%HERMES_PYTHON%")
"%MIA_APP_PY%" "%~dp0..\miaos-app-cli.py" %*
