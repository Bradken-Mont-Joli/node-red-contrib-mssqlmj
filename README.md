# @bkmj/node-red-contrib-mssqlmj

A ultra-fast, robust, and feature-rich Microsoft SQL Server node for Node-RED, built directly on top of the native `tedious` driver and powered by `tarn.js` connection pooling.

Designed specifically to eliminate severe WAN/VPN latency (~2000ms down to ~200ms) by bypassing the overhead of repeated connection resets (`sp_reset_connection`) found in traditional `node-mssql` wrappers.


## Key Features

* **Drop-in Compatibility**: Full layout and functional alignment with `node-red-contrib-mssql-plus` (`parseMustache`, `returnType`, `throwErrors`, `expand editor`).
* **Ultra-Low Latency (WAN Optimized)**: Direct execution via Tedious `execSql()`, holding persistent sockets open across high-latency WAN links (e.g., Australia/USA links).
* **Pool Socket Pre-Warming**: Option to pre-open min-pool connections on flow startup to avoid connection delay on the first API request.
* **Tarn.js Connection Pooling**: Robust connection pool management with automatic socket validation and recovery.
* **Mustache Templating**: Parse `{{msg.val}}`, `{{flow.val}}`, `{{global.val}}`, and `{{env.val}}` directly inside the SQL query editor.
* **BigInt Crash Protection**: Automatically converts 64-bit SQL Server integers (`BigInt`) into safe JavaScript numbers/strings to prevent Node-RED process crashes during JSON serialization.
* **Flexible Error Handling**: Choose between throwing errors for `Catch` nodes (`throwErrors: 1`) or passing errors downstream in `msg.error` (`throwErrors: 0`).
* **Streaming / Split Messages**: Stream large result sets chunk-by-chunk with standard Node-RED `msg.parts` metadata for `join` nodes.
* **Exponential Backoff & Jitter**: Built-in automatic retries for temporary VPN drops or network micro-cuts.
* **NTLM Active Directory Support**: Native Windows Domain authentication support.


## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install @bkmj/node-red-contrib-mssqlmj
```

## Configuration (mssqlmj-config)

* **Server / Port / Database:** Connection details for your SQL Server.
* **Authentication:** Supports SQL Server Authentication (default) and Active Directory (ntlm).
* **Min Pool / Max Pool:** Set the Tarn.js pool boundaries (e.g., Min: 2, Max: 10 or 15 for heavy parallel reports).
* **Pre-warm pool on startup:** Pre-establishes sockets upon flow deployment to keep the first query instantaneous.
* **Network & Retries:** Configure connection/request timeouts, TLS encryption, trust certificate, retry attempts, and retry delays.

## Query Node (mssqlmj-query)

### Inputs

* Query: Defined in the Ace editor or dynamically passed via msg.query or msg.payload.
* Parameters: Passed via msg.params (Object or Array) or configured properties.
* Parse Mustache: Enabled by default to evaluate Mustache variables prior to execution.

### Outputs

* **Output Property:** Configurable destination (default: msg.payload).
* **Output Type:**

    * `0`: Original output (Returns an array of row objects).
    * `1`: Driver output (Returns { recordset: [...], rowsAffected: [...] }).

* **Error Handling:**

    * `Throw error`: Halts execution and triggers a Node-RED Catch node.
    * `Send in msg.error`: Attaches error details to msg.error and continues downstream.

## Usage Examples

1. Parameterized Query (SQL Injection Safe)

```javaScript
msg.query = "SELECT * FROM dbo.Orders WHERE Status = @status AND TotalAmount > @minAmount";
msg.params = {
    status: "APPROVED",
    minAmount: 500.00
};
return msg;
```

2. Mustache Templating with Flow/Global Context

```sql
SELECT PartNum, PartDescription 
FROM dbo.Part 
WHERE Plant = '{{flow.plantId}}' 
  AND CreatedOn >= '{{msg.startDate}}'
```

## Locales Supported

* **English** (`en-US`)
* **Français** (`fr-CA`)

## License

MIT
