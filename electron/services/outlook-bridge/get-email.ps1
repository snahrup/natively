# get-email.ps1 — Fetch a single email by EntryID with full body
# Parameters: -EntryId <string>
param(
    [Parameter(Mandatory=$true)]
    [string]$EntryId
)

$ErrorActionPreference = 'Stop'

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")

    $item = $namespace.GetItemFromID($EntryId)

    if ($item.Class -ne 43) {
        throw "Item is not a MailItem (class $($item.Class))"
    }

    $attachments = @()
    if ($item.HasAttachments) {
        foreach ($att in $item.Attachments) {
            if ($att.Type -eq 1) {  # olByValue
                $attachments += @{
                    filename = $att.FileName
                    size     = $att.Size
                }
            }
        }
    }

    $toRecipients = @()
    $ccRecipients = @()
    foreach ($recip in $item.Recipients) {
        $entry = @{
            name    = $recip.Name
            address = $recip.Address
        }
        if ($recip.Type -eq 1) { $toRecipients += $entry }      # olTo
        elseif ($recip.Type -eq 2) { $ccRecipients += $entry }   # olCC
    }

    $preview = ""
    try {
        $bodyText = $item.Body
        if ($bodyText -and $bodyText.Length -gt 0) {
            $preview = if ($bodyText.Length -gt 200) { $bodyText.Substring(0, 200) } else { $bodyText }
        }
    } catch { }

    $email = @{
        id               = $item.EntryID
        subject          = $item.Subject
        from             = @{
            name    = $item.SenderName
            address = $item.SenderEmailAddress
        }
        toRecipients     = $toRecipients
        ccRecipients     = $ccRecipients
        bodyPreview      = $preview
        body             = @{
            contentType = if ($item.BodyFormat -eq 2) { "html" } else { "text" }
            content     = if ($item.BodyFormat -eq 2) { $item.HTMLBody } else { $item.Body }
        }
        receivedDateTime = $item.ReceivedTime.ToString("o")
        isRead           = -not $item.UnRead
        hasAttachments   = [bool]$item.HasAttachments
        importance       = @('low','normal','high')[$item.Importance]
        flag             = @{ flagStatus = if ($item.FlagRequest) { "flagged" } else { "notFlagged" } }
        conversationId   = $item.ConversationID
        parentFolderId   = ""
        webLink          = ""
        attachments      = $attachments
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    $email | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{
        error = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
}
