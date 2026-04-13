# Microsoft Connectors Spec

## Scope

Add staged Microsoft 365 support for:

- Outlook email
- Outlook calendar
- Teams chats/messages

## Mode

Read-first by default.

Write actions may exist, but should not be part of proactive automation until read-side quality is proven.

## Auth

- Outlook Desktop via local COM automation
- zero Azure / Graph approval dependency
- Teams via local WebView2/CDP bridge when remote debugging is enabled
- no tenant or OAuth approval required for the primary path

## Retrieval Role

- email threads feed prep packets and reminders
- Teams threads feed recent discussion context and commitments
- Outlook calendar feeds the same prep spine as Google calendar

## Non-Goals

- silent autonomous sending
- building a second approval-dependent Graph path before the local path is stable

## Optional Fallback

Graph may remain a dormant fallback later, but the supported primary path is local Outlook COM plus local Teams bridge.
