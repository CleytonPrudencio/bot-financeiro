@echo off
rem Ponte MetaTrader 5 do Bot Financeiro. Deixe o MetaTrader 5 aberto e logado na XP antes.
cd /d "%~dp0"
python -m pip install --quiet --upgrade MetaTrader5
:de_novo
python ponte.py
echo A ponte parou. Tentando de novo em 10 segundos (feche esta janela para parar de vez).
timeout /t 10 >nul
goto de_novo
