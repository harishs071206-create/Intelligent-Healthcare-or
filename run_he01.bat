@echo off
title HE-01 Intelligent Operating Room Scheduling Command Center
color 0B

echo ===============================================================================
echo   ST. JUDE METROPOLITAN ACADEMIC MEDICAL CENTER
echo   HE-01 Intelligent Operating Room Scheduling ^& Emergency Optimization Engine
echo ===============================================================================
echo.

echo [1/3] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Python was not detected in PATH.
    echo Opening Standalone Dashboard directly in your default browser...
    start standalone_dashboard.html
    pause
    exit /b
)

echo [2/3] Initializing Server Database and Optimizer Engine...
echo Running app.py on http://127.0.0.1:5000...
echo.

start http://127.0.0.1:5000
python app.py

pause