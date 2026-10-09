@echo off
rem 用 Windows 自带的 C# 编译器生成 历史模拟RPG.exe（放在游戏根目录）
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /win32icon:game.ico /out:"..\历史模拟RPG.exe" /r:System.Windows.Forms.dll GameLauncher.cs
