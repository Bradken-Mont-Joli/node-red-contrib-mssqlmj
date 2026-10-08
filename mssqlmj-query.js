const { Request, TYPES } = require('tedious');
const Mustache = require('mustache');

function inferTediousType(value) {
    if (value === null || value === undefined) return TYPES.Null;
    if (typeof value === 'boolean') return TYPES.Bit;
    if (typeof value === 'string') return TYPES.NVarChar;
    if (typeof value === 'number') return Number.isInteger(value) ? TYPES.Int : TYPES.Float;
    if (value instanceof Date) return TYPES.DateTime;
    if (Buffer.isBuffer(value)) return TYPES.VarBinary;
    return TYPES.NVarChar;
}

function sanitizeColumnValue(val) {
    if (typeof val === 'bigint') {
        return (val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER))
            ? Number(val)
            : val.toString();
    }
    return val;
}

module.exports = function(RED) {
    function MSSQLMJQueryNode(config) {
        RED.nodes.createNode(this, config);
        this.serverConfig = RED.nodes.getNode(config.serverConfig);

        this.query = config.query || "";
        this.querySource = config.querySource || "query";
        this.querySourceType = config.querySourceType || "msg";
        this.paramsSource = config.paramsSource || "params";
        this.paramsSourceType = config.paramsSourceType || "msg";
        this.outField = config.outField || "payload";
        this.split = config.split || false;
        this.rowsPerMsg = parseInt(config.rowsPerMsg, 10) || 1;

        const node = this;

        node.getEvaluatedProperty = function(prop, propType, msg) {
            return new Promise((resolve) => {
                if (!prop) return resolve(undefined);
                RED.util.evaluateNodeProperty(prop, propType, node, msg, (err, res) => {
                    if (err) resolve(undefined);
                    else resolve(res);
                });
            });
        };

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            if (!node.serverConfig) {
                node.status({ fill: "red", shape: "ring", text: "Configuration manquante" });
                return done(new Error("Aucun serveur configuré"));
            }

            if (!msg._mssql_attempt) msg._mssql_attempt = 0;

            let rawQuery;
            let paramsVal;

            try {
                rawQuery = await node.getEvaluatedProperty(node.querySource, node.querySourceType, msg);
                if (!rawQuery && typeof msg.payload === 'string') rawQuery = msg.payload;
                if (!rawQuery) rawQuery = node.query;

                if (!rawQuery) return done(new Error("Requête SQL vide"));

                paramsVal = await node.getEvaluatedProperty(node.paramsSource, node.paramsSourceType, msg);

                if ((!paramsVal || Object.keys(paramsVal).length === 0) && rawQuery.includes("{{")) {
                    rawQuery = Mustache.render(rawQuery, { msg: msg, flow: node.context().flow, global: node.context().global });
                }
            } catch (evalErr) {
                node.status({ fill: "red", shape: "ring", text: "Erreur évaluation" });
                return done(evalErr);
            }

            const executeQueryWithRetry = async () => {
                const startTime = Date.now();
                node.status({ fill: "blue", shape: "dot", text: "Acquisition pool..." });

                let connection;
                try {
                    connection = await node.serverConfig.acquire();
                } catch (acquireErr) {
                    return handleQueryError(acquireErr);
                }

                node.status({ fill: "yellow", shape: "dot", text: "Exécution..." });

                let rowsData = [];
                let totalRows = 0;
                let partsIndex = 0;
                const partsId = Math.random().toString(36).substring(2, 9);

                const request = new Request(rawQuery, (reqErr, rowCount) => {
                    if (connection) {
                        if (reqErr && connection.state && connection.state.name !== 'LoggedIn') {
                            try { node.serverConfig.pool.destroy(connection); } catch(e){}
                        } else {
                            node.serverConfig.release(connection);
                        }
                    }

                    if (reqErr) {
                        return handleQueryError(reqErr);
                    }

                    try {
                        if (node.split) {
                            sendChunk(rowsData, true);
                        } else {
                            const msgToSend = RED.util.cloneMessage(msg);
                            RED.util.setMessageProperty(msgToSend, node.outField, rowsData);
                            msgToSend.mssql = { rowCount: totalRows, queryDurationMs: Date.now() - startTime };

                            node.status({ fill: "green", shape: "dot", text: `${totalRows} lignes (${msgToSend.mssql.queryDurationMs}ms)` });
                            send(msgToSend);
                        }
                        delete msg._mssql_attempt;
                        done();
                    } catch (postErr) {
                        node.status({ fill: "red", shape: "dot", text: "Erreur traitement" });
                        done(postErr);
                    }
                });

                function sendChunk(rowsChunk, isComplete) {
                    if (rowsChunk.length === 0 && !isComplete) return;

                    const msgChunk = RED.util.cloneMessage(msg);
                    const payloadData = (node.rowsPerMsg === 1 && rowsChunk.length === 1) ? rowsChunk[0] : rowsChunk;

                    RED.util.setMessageProperty(msgChunk, node.outField, payloadData);
                    msgChunk.parts = {
                        id: partsId,
                        type: "array",
                        index: partsIndex++,
                        count: isComplete ? partsIndex : undefined
                    };
                    if (isComplete) msgChunk.complete = true;
                    msgChunk.mssql = { rowCount: totalRows, queryDurationMs: Date.now() - startTime };

                    send(msgChunk);
                }

                // Lecture robuste des colonnes (tableau ou objet)
                request.on('row', (columns) => {
                    totalRows++;
                    let rowObj = {};

                    if (Array.isArray(columns)) {
                        columns.forEach(col => {
                            rowObj[col.metadata.colName] = sanitizeColumnValue(col.value);
                        });
                    } else if (columns && typeof columns === 'object') {
                        Object.keys(columns).forEach(key => {
                            const col = columns[key];
                            rowObj[key] = sanitizeColumnValue((col && col.value !== undefined) ? col.value : col);
                        });
                    }

                    if (node.split) {
                        rowsData.push(rowObj);
                        if (rowsData.length >= node.rowsPerMsg) {
                            sendChunk(rowsData, false);
                            rowsData = [];
                        }
                    } else {
                        rowsData.push(rowObj);
                    }
                });

                try {
                    if (paramsVal && typeof paramsVal === 'object') {
                        if (Array.isArray(paramsVal)) {
                            paramsVal.forEach((val, idx) => {
                                request.addParameter(`p${idx}`, inferTediousType(val), val);
                            });
                        } else {
                            for (const [pName, pVal] of Object.entries(paramsVal)) {
                                request.addParameter(pName, inferTediousType(pVal), pVal);
                            }
                        }
                    }

                    connection.execSql(request);
                } catch (execErr) {
                    if (connection) node.serverConfig.release(connection);
                    handleQueryError(execErr);
                }
            };

            function handleQueryError(err) {
                const maxAttempts = node.serverConfig.retryAttempts || 3;
                const baseDelay = node.serverConfig.retryDelay || 500;

                if (msg._mssql_attempt < maxAttempts) {
                    msg._mssql_attempt++;
                    const jitter = Math.floor(Math.random() * 200);
                    const delay = (baseDelay * Math.pow(2, msg._mssql_attempt - 1)) + jitter;

                    node.warn(`[MSSQL MJ] Erreur (${err.message}). Re-tentative ${msg._mssql_attempt}/${maxAttempts} dans ${delay}ms...`);
                    node.status({ fill: "red", shape: "ring", text: `Retry dans ${delay}ms` });

                    setTimeout(() => {
                        executeQueryWithRetry().catch(e => {
                            node.status({ fill: "red", shape: "dot", text: "Erreur fatale" });
                            done(e);
                        });
                    }, delay);
                } else {
                    node.status({ fill: "red", shape: "dot", text: "Erreur SQL" });
                    delete msg._mssql_attempt;
                    done(err);
                }
            }

            executeQueryWithRetry().catch(e => {
                node.status({ fill: "red", shape: "dot", text: "Erreur fatale" });
                done(e);
            });
        });
    }

    RED.nodes.registerType("mssqlmj-query", MSSQLMJQueryNode);
};