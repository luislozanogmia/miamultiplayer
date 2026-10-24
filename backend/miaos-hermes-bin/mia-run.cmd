@echo off
rem Automation progress reports for Hermes processes; see ..\miaos-run-cli.py.
if "%HERMES_PYTHON%"=="" (set "MIA_RUN_PY=python") else (set "MIA_RUN_PY=%HERMES_PYTHON%")
"%MIA_RUN_PY%" "%~dp0..\miaos-run-cli.py" %*
