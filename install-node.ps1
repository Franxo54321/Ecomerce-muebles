# Intento sencillo de instalación de Node.js en Windows.
# Ejecutar desde PowerShell como Administrador:
#   cd "C:\Users\a\Desktop\pagina de muebles"
#   .\install-node.ps1

Write-Host "Comprobando si Node.js ya está instalado..." -ForegroundColor Cyan
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node ya instalado:" (node -v) -ForegroundColor Green
    exit 0
}

# Intentar usar Chocolatey
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Host "Chocolatey no encontrado. Intentando instalar Chocolatey (se necesita PowerShell como Administrador)..." -ForegroundColor Yellow
    try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        Start-Sleep -Seconds 3
    } catch {
        Write-Host "No se pudo instalar Chocolatey automáticamente:" $_.Exception.Message -ForegroundColor Red
    }
}

if (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Instalando Node.js LTS con Chocolatey..." -ForegroundColor Cyan
    try {
        choco install nodejs-lts -y
        Write-Host "Instalación de Node.js con Chocolatey finalizada. Cierra y abre la terminal y ejecuta node -v" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "Error instalando Node con Chocolatey: " $_.Exception.Message -ForegroundColor Red
    }
}

# Si no hay choco o la instalación falló, abrir la página oficial para descarga manual
Write-Host "No se pudo instalar automáticamente. Abriendo la página oficial de Node.js para descarga manual..." -ForegroundColor Yellow
Start-Process "https://nodejs.org/en/download/"

Write-Host "`nInstrucciones: descarga el instalador LTS (MSI), ejecútalo como Administrador, luego cierra y abre PowerShell y ejecuta:" -ForegroundColor Cyan
Write-Host "node -v" -ForegroundColor Green
Write-Host "npm -v" -ForegroundColor Green
