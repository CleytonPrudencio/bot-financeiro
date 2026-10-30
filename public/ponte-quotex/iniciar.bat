@echo off
rem Ponte Quotex do Bot Financeiro (opcoes binarias). Preencha o ponte.env antes.
cd /d "%~dp0"
python -m pip install --quiet --upgrade https://github.com/cleitonleonel/pyquotex/archive/refs/heads/master.zip
:de_novo
python ponte.py
echo A ponte parou. Tentando de novo em 10 segundos (feche esta janela para parar de vez).
timeout /t 10 >nul
goto de_novo
