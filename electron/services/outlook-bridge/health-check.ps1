# health-check.ps1 — Verify Outlook COM is available and responsive
# Returns JSON: { outlookRunning, comAvailable, userEmail, userName, error, outlookType }

$ErrorActionPreference = 'Stop'

# Detect which Outlook variant is running
$classicRunning = $null -ne (Get-Process -Name "OUTLOOK" -ErrorAction SilentlyContinue)
$newOutlookRunning = $null -ne (Get-Process -Name "olk" -ErrorAction SilentlyContinue)

if (-not $classicRunning -and $newOutlookRunning) {
    # New Outlook (olk.exe) is running — no COM support
    @{
        outlookRunning = $true
        comAvailable   = $false
        userEmail      = $null
        userName       = $null
        outlookType    = "new"
        error          = "New Outlook detected (no COM support). Switch to classic Outlook for email integration."
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not $classicRunning -and -not $newOutlookRunning) {
    @{
        outlookRunning = $false
        comAvailable   = $false
        userEmail      = $null
        userName       = $null
        outlookType    = "none"
        error          = "Outlook Desktop is not running"
    } | ConvertTo-Json -Compress
    exit 0
}

# Classic Outlook is running — try COM
try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")
    $user = $namespace.CurrentUser
    $userEmail = ''
    try {
        # Try to get SMTP address via PropertyAccessor
        $PR_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x39FE001E"
        $userEmail = $user.PropertyAccessor.GetProperty($PR_SMTP)
    } catch {
        $userEmail = $user.Address
    }

    $result = @{
        outlookRunning = $true
        comAvailable   = $true
        userEmail      = $userEmail
        userName       = $user.Name
        outlookType    = "classic"
        error          = $null
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    $result | ConvertTo-Json -Compress
} catch {
    @{
        outlookRunning = $true
        comAvailable   = $false
        userEmail      = $null
        userName       = $null
        outlookType    = "classic"
        error          = "Outlook is running but COM connection failed: $($_.Exception.Message)"
    } | ConvertTo-Json -Compress
}
