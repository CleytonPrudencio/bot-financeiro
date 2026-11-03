@echo off
rem Ponte MetaTrader 5 do Bot Financeiro. Deixe o MetaTrader 5 aberto e logado antes.
cd /d "%~dp0"
rem O pacote MetaTrader5 so existe ate o Python 3.14: usa o mais novo que tiver ate ele.
set PY=
for %%v in (3.14 3.13 3.12 3.11 3.10) do (
  if not defined PY (
    py -%%v -c "import sys" >nul 2>&1 && set "PY=py -%%v"
  )
)
if not defined PY (
  echo Nao achei Python 3.10 a 3.14. O pacote MetaTrader5 nao existe para versoes mais novas.
  echo Instale o Python 3.13 em python.org ^(marque "Add Python to PATH"^) e rode de novo.
  pause
  exit /b 1
)
echo Usando %PY%
%PY% -m pip install --quiet --upgrade MetaTrader5
:de_novo
%PY% ponte.py
echo A ponte parou. Tentando de novo em 10 segundos (feche esta janela para parar de vez).
timeout /t 10 >nul
goto de_novo
