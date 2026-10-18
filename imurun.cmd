@echo off
rem IMURUN dev launcher (Windows) — runs the CLI from source with Bun, so you
rem can use `imurun ...` in this checkout without a global install.
rem   imurun.cmd chat
rem   imurun.cmd run "explain this project"
call bun "%~dp0packages\cli\src\index.ts" %*
