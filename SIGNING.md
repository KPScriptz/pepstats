# Code signing (Windows)

The build is **signing-ready but ships unsigned by default**. Until a certificate
is supplied, the installer runs but SmartScreen shows *"Windows protected your
PC / unknown publisher"* (More info → Run anyway). Signing removes that warning
and builds publisher reputation over time.

`electron-builder` picks up signing automatically from environment variables — no
`package.json` changes needed. Pick **one** of the options below.

## Option A — OV/EV certificate (.pfx)

If you have a standard OV code-signing certificate as a `.pfx`/`.p12` file:

```powershell
$env:CSC_LINK = "C:\path\to\pepstats-cert.pfx"   # or a base64 string of the file
$env:CSC_KEY_PASSWORD = "your-cert-password"
npm run dist
```

EV certificates on a hardware token (USB/HSM) can't export a `.pfx`; use the
token vendor's signing tool or Azure Trusted Signing (Option B) instead.

> Note: OV certs no longer get *instant* SmartScreen trust — reputation still
> accrues with downloads. EV and Azure Trusted Signing get trusted faster.

## Option B — Azure Trusted Signing (recommended, ~$10/mo)

Microsoft's cloud signing service; identity-verified, no hardware token, fast
SmartScreen trust. After creating the Azure resource and completing identity
validation, add an `azureSignOptions` block under `build.win` in `package.json`:

```json
"win": {
  "target": "nsis",
  "icon": "build/icon.ico",
  "azureSignOptions": {
    "publisherName": "Your Verified Name",
    "endpoint": "https://eus.codesigning.azure.net/",
    "certificateProfileName": "pepstats-profile",
    "codeSigningAccountName": "pepstats-signing"
  }
}
```

and provide the Azure credentials as env vars (`AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) before `npm run dist`.

## Option C — Self-signed (testing only)

Verifies the signing pipeline but **does not** remove SmartScreen warnings — do
not use for public releases.

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=PepStats Dev" -CertStoreLocation Cert:\CurrentUser\My
$pwd  = ConvertTo-SecureString -String "test123" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath build\selfsign.pfx -Password $pwd
$env:CSC_LINK = "build\selfsign.pfx"; $env:CSC_KEY_PASSWORD = "test123"
npm run dist
```

## CI (GitHub Actions)

Store the cert as a base64 secret and expose it to the build step:

```yaml
env:
  CSC_LINK: ${{ secrets.WINDOWS_CERT_BASE64 }}
  CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
```
