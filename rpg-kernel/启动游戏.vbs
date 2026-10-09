' ============================================================
'  Pivot Engine - one-click launcher (VBScript)
'  Double-click this file to start the game.
'  It runs 一键启动.bat through cmd.exe, so it works even if
'  Windows has .bat files wrongly associated with Notepad.
' ============================================================
On Error Resume Next

Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "一键启动.bat")

If Not fso.FileExists(batPath) Then
    MsgBox "找不到 一键启动.bat。" & vbCrLf & "请确认本文件与 一键启动.bat 放在同一个文件夹里。", 16, "Pivot Engine"
    WScript.Quit 1
End If

' Run the bat in a visible command window. That black window IS the server -
' keep it open while playing; close it to stop the game.
quoted = Chr(34) & batPath & Chr(34)
WshShell.Run "cmd.exe /c " & quoted, 1, False

If Err.Number <> 0 Then
    MsgBox "启动失败：" & Err.Description & vbCrLf & vbCrLf & _
           "备用办法：打开本文件夹，点顶部地址栏输入 cmd 回车，" & _
           "再输入 一键启动.bat 回车。", 16, "Pivot Engine"
    WScript.Quit 1
End If
