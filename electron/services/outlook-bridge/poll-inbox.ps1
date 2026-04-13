# poll-inbox.ps1 — Fast inbox listing via MAPI Table API
# Uses Folder.GetTable() which reads from the folder's cached table — no per-item hydration.
# Parameters: -Since <ISO8601> -MaxItems <int> -UnreadOnly <switch> -Folder <string>
param(
    [string]$Since = "",
    [int]$MaxItems = 50,
    [switch]$UnreadOnly,
    [string]$Folder = "inbox"
)

$ErrorActionPreference = 'Stop'

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")

    # Map folder name to Outlook constant
    $folderMap = @{
        'inbox'     = 6
        'sentitems' = 5
        'drafts'    = 16
        'deleted'   = 3
        'junk'      = 23
        'outbox'    = 4
    }
    $folderId = if ($folderMap.ContainsKey($Folder.ToLower())) { $folderMap[$Folder.ToLower()] } else { 6 }
    $mailFolder = $namespace.GetDefaultFolder($folderId)

    # Build DASL filter for Table API
    $filterParts = @()
    if ($Since) {
        $sinceDate = [DateTime]::Parse($Since).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        $filterParts += """urn:schemas:httpmail:datereceived"" >= '$sinceDate'"
    }
    if ($UnreadOnly) {
        $filterParts += """urn:schemas:httpmail:read"" = 0"
    }
    $filter = ""
    if ($filterParts.Count -gt 0) {
        $filter = "@SQL=" + ($filterParts -join " AND ")
    }

    $table = if ($filter) { $mailFolder.GetTable($filter) } else { $mailFolder.GetTable() }

    # Define columns we want — pipe Add() to Out-Null to suppress COM object output
    $table.Columns.RemoveAll() | Out-Null
    $table.Columns.Add("EntryID") | Out-Null
    $table.Columns.Add("Subject") | Out-Null
    $table.Columns.Add("SenderName") | Out-Null
    $table.Columns.Add("SenderEmailAddress") | Out-Null
    $table.Columns.Add("ReceivedTime") | Out-Null
    $table.Columns.Add("UnRead") | Out-Null
    $table.Columns.Add("Importance") | Out-Null
    $table.Columns.Add("MessageClass") | Out-Null
    # PR_HASATTACH (0x0E1B000B)
    $table.Columns.Add("http://schemas.microsoft.com/mapi/proptag/0x0E1B000B") | Out-Null
    # PR_FLAG_STATUS (0x10900003)
    $table.Columns.Add("http://schemas.microsoft.com/mapi/proptag/0x10900003") | Out-Null

    # Sort by ReceivedTime descending
    $table.Sort("[ReceivedTime]", $true)

    $emails = @()
    $count = 0

    while (-not $table.EndOfTable -and $count -lt $MaxItems) {
        $row = $table.GetNextRow()

        # Only process IPM.Note (email) items — skip meeting requests, etc.
        $msgClass = ""
        try { $msgClass = $row.Item("MessageClass").ToString() } catch {}
        if ($msgClass -and -not $msgClass.StartsWith("IPM.Note")) { continue }

        $flagVal = 0
        try { $flagVal = [int]$row.Item("http://schemas.microsoft.com/mapi/proptag/0x10900003") } catch {}
        $hasAtt = $false
        try { $hasAtt = [bool]$row.Item("http://schemas.microsoft.com/mapi/proptag/0x0E1B000B") } catch {}
        $importance = 1
        try { $importance = [int]$row.Item("Importance") } catch {}
        $unread = $false
        try { $unread = [bool]$row.Item("UnRead") } catch {}

        $email = @{
            id               = $row.Item("EntryID")
            subject          = $row.Item("Subject")
            from             = @{
                name    = $row.Item("SenderName")
                address = $row.Item("SenderEmailAddress")
            }
            toRecipients     = @()
            ccRecipients     = @()
            bodyPreview      = ""
            body             = @{ contentType = "text"; content = "" }
            receivedDateTime = $row.Item("ReceivedTime").ToString("o")
            isRead           = -not $unread
            hasAttachments   = $hasAtt
            importance       = @('low','normal','high')[$importance]
            flag             = @{ flagStatus = if ($flagVal -ge 2) { "flagged" } else { "notFlagged" } }
            conversationId   = ""
            parentFolderId   = $Folder
            webLink          = ""
            attachments      = @()
        }

        $emails += $email
        $count++
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($table) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($mailFolder) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    @{
        emails     = $emails
        totalCount = $emails.Count
    } | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{
        error = $_.Exception.Message
        emails = @()
        totalCount = 0
    } | ConvertTo-Json -Depth 5 -Compress
}
