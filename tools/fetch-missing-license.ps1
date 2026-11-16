$ErrorActionPreference = 'Stop'
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE' -OutFile (Join-Path $PSScriptRoot '../licenses/react-remove-scroll-bar-MIT.txt')
