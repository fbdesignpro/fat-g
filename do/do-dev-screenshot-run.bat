@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Double-click to start dev at 1920x1080 with a fresh copy of the saved screenshot setup.
call "%~dp0do-dev-setup.bat" run
exit /b %errorlevel%
