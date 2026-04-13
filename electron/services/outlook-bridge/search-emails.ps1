# search-emails.ps1 — Search recent inbox mail with local text matching
param(
    [string]$Query = "",
    [int]$MaxItems = 25
)

$ErrorActionPreference = 'Stop'

function Get-SearchTerms {
    param([string]$RawQuery)

    if ([string]::IsNullOrWhiteSpace($RawQuery)) {
        return @()
    }

    $normalized = ($RawQuery -replace '[\r\n\t]+', ' ').Trim().ToLowerInvariant()
    $terms = $normalized -split '[^a-z0-9@._-]+' |
        Where-Object { $_.Length -ge 3 } |
        Select-Object -Unique -First 8

    return @($terms)
}

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")
    $inbox = $namespace.GetDefaultFolder(6)
    $terms = Get-SearchTerms -RawQuery $Query

    $items = $inbox.Items
    $items.Sort("[ReceivedTime]", $true)

    $emails = @()
    $count = 0
    $scanned = 0

    foreach ($item in $items) {
        if ($count -ge $MaxItems -or $scanned -ge 300) { break }
        $scanned++
        if ($item.Class -ne 43) { continue }

        $bodyText = if ($item.Body) { [string]$item.Body } else { "" }
        $subject = if ($item.Subject) { [string]$item.Subject } else { "" }
        $senderEmail = if ($item.SenderEmailAddress) { [string]$item.SenderEmailAddress } else { "" }
        $senderName = if ($item.SenderName) { [string]$item.SenderName } else { "" }

        if ($terms.Count -gt 0) {
            $haystack = @($subject, $senderEmail, $senderName, $bodyText) -join "`n"
            $haystackLower = $haystack.ToLowerInvariant()
            $matched = $false

            foreach ($term in $terms) {
                if ($haystackLower.Contains($term)) {
                    $matched = $true
                    break
                }
            }

            if (-not $matched) { continue }
        }

        $toRecipients = @()
        $ccRecipients = @()
        foreach ($recip in $item.Recipients) {
            $entry = @{ name = $recip.Name; address = $recip.Address }
            if ($recip.Type -eq 1) { $toRecipients += $entry }
            elseif ($recip.Type -eq 2) { $ccRecipients += $entry }
        }

        $emails += @{
            id               = $item.EntryID
            subject          = $subject
            from             = @{ name = $senderName; address = $senderEmail }
            toRecipients     = $toRecipients
            ccRecipients     = $ccRecipients
            bodyPreview      = if ($bodyText.Length -gt 200) { $bodyText.Substring(0, 200) } else { $bodyText }
            body             = @{
                contentType = if ($item.BodyFormat -eq 2) { "html" } else { "text" }
                content     = if ($item.BodyFormat -eq 2) { $item.HTMLBody } else { $bodyText }
            }
            receivedDateTime = $item.ReceivedTime.ToString("o")
            isRead           = -not $item.UnRead
            hasAttachments   = $item.HasAttachments
            importance       = @('low','normal','high')[$item.Importance]
            flag             = @{ flagStatus = if ($item.FlagRequest) { "flagged" } else { "notFlagged" } }
            conversationId   = $item.ConversationID
            parentFolderId   = "inbox"
            webLink          = ""
        }
        $count++
        try { [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null } catch { }
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($items) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($inbox) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    @{ emails = $emails; totalCount = $emails.Count } | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{ error = $_.Exception.Message; emails = @(); totalCount = 0 } | ConvertTo-Json -Depth 5 -Compress
}
