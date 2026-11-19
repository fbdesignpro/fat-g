@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Starts fat-g in the demo source's stream form (docs/planning/_archive/M19.md, Design 9; V17): one project,
rem one session, the long-conversation fixture in that session's chat, two empty chats beside it
rem for a plan several chats share (Second chat, Third chat), and the fixture's three
rem streams played into it. It is what the recorded performance runs are made with. It starts no CLI
rem and spends no turn. Its data lives in fatg-stream under %TEMP%, which each run makes anew:
rem neither %APPDATA%\fat-g-dev nor %APPDATA%\fat-g is opened (see do-readme.md).
rem
rem   do-run-stream.bat            the development build (npm run dev)
rem   do-run-stream.bat packaged   builds the smoke flavor (npm run package:smoke) and starts it
rem
rem In "Fixture streams", send any prompt to play the next stream, or mixed, fence or table to play
rem that one. This window, and the page's console, show the page's count of long tasks and long
rem animation frames with the longest of each, and the newest page's time: one line when a prompt is
rem sent, for what came before the stream, and one after it, for the stream alone.
rem
rem Since M20a (docs/planning/_archive/M20a.md, V11) each turn of the fixture also holds what it did, a group of
rem twenty activities, and two more prompts play a turn of work: tools runs twenty tools into the
rem full window, and worker does the same with a sub-agent whose answer streams into its own tab.
rem Open that tab from the sub-agent's row, or from the agent list, while it is written.
rem
rem Since M20b (docs/planning/_archive/M20b.md, V17) the session keeps two hundred side questions from its
rem start, about its newest hundred answers: their markers are drawn beside those answers. Once a
rem prompt was sent, Explain this on a passage, or Side question above the input, plays an answer
rem into the question's own tab beside the full window: written as it arrives, or, for a question
rem that begins with the word whole, all at once after two seconds. Each is reported as a stream is.
rem
rem Since M21 (docs/planning/_archive/M21.md, V12) the prompt question plays a turn that asks: a card with two
rem options and a field for something else, which holds the turn until Submit is pressed, then a
rem message that carries a question of its own, whose card is answered by a prompt or dismissed.
rem A word after it plays a card no CLI shows on request (V16): question form asks three at once,
rem several options to choose among, a text alone and a secret, and confirms nothing once answered;
rem question worker has a sub-agent ask, in its own tab; question withdrawn takes its question back
rem after five seconds and goes on; question lost ends after five seconds as a lost process does.
rem
rem Since M22 (docs/planning/_archive/M22.md, V12) the session has two modes, Read only and Ask first, in the
rem menu above the black line at the chat's right (M100), and starts under Ask first. The
rem prompt approval plays a turn that asks leave for an action: a card with the whole action, and
rem Approve once, Deny and Stop.
rem A word after it chooses the card, or a state no CLI shows on request:
rem   approval command   asks to run one command, approved once or denied; the word alone does too
rem   approval file      asks to change two files, one outside the project's folders, with an edit of
rem                      every matching passage and a change long enough to be drawn only once opened
rem   approval grant     asks to run a command the session's grant can cover: once approved for the
rem                      session, the same prompt runs with no card, until the process is closed
rem   approval denied    shows an action a rule of the configuration declined, with no card
rem   approval worker    has a sub-agent ask, in its own tab
rem   approval setup     asks nothing: from then on Ask first needs a sandbox setup, whose first try
rem                      fails and whose second completes; open the mode menu to see its dialog
rem   approval unknown   the same, but the first try waits until Stop waiting, and its outcome is
rem                      unknown
rem Under Read only each asking word is refused, as a real request is. A change of mode closes the
rem session's process, and ends the grant with it.
setlocal
cd /d "%~dp0"

rem npm is not always on PATH (a shell opened before Node was installed, for one): try the default install.
where npm >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 24 or later, then try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo The dependencies are not installed. Run "npm install" in this folder first.
  pause
  exit /b 1
)

set "FATG_DEMO_SESSIONS=stream"
set "FATG_DEMO_FIXTURE=%~dp0tests\fixtures\conversations\long-conversation.mjs"

if /i "%~1"=="packaged" goto packaged

call npm run dev
if errorlevel 1 pause
endlocal
exit /b 0

:packaged
call npm run package:smoke
if errorlevel 1 (
  echo The smoke flavor could not be built.
  pause
  exit /b 1
)
if not exist "release\smoke\win-unpacked\fat-g.exe" (
  echo release\smoke\win-unpacked\fat-g.exe was not found after the build.
  pause
  exit /b 1
)
rem Started here, and waited for, so that its lines show in this window.
"release\smoke\win-unpacked\fat-g.exe"
if errorlevel 1 pause
endlocal
