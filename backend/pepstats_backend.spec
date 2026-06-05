# PyInstaller spec — builds a single-file Windows binary:
#   backend/dist/pepstats-backend.exe
# package.json's extraResources then packs backend/dist into the installer
# under resources/backend/.
# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="pepstats-backend",
    debug=False,
    strip=False,
    upx=True,
    console=True,
)
