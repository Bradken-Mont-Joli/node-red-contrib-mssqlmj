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
        this.querySource = config.querySource || "editor";
        this.querySourceType = config.querySourceType || "editor";
        this.paramsSource = config.paramsSource || "none";
        this.paramsSourceType = config.paramsSourceType || "none";
        this.outField = config.outField || "payload";
        this.parseMustache = config.parseMustache !== undefined ? config.parseMustache : true;
        this.returnType = parseInt(config.returnType, 10) || 0; // 0 = Rows, 1 = Driver Metadata[cite: 31]
        this.throwErrors = parseInt(config.throwErrors, 10) === 1; // 1 = Throw, 0 = Send in msg[cite: 31]
        this.split = config.split || false;
        this.rowsPerMsg = parseInt(config.rowsPerMsg, 10) || 1;

        const node = this;

        node.getEvaluatedProperty = function(prop, propType, msg) {
            if (propType === 'editor' || propType === 'none') return Promise.resolve(undefined);
            return new Promise((resolve) => {
                if (!prop) return resolve(undefined);
                RED.util.evaluateNodeProperty(prop, propType, node, msg, (err, res) => {
                    if (err) resolve(undefined);
                    else resolve(res);
                });
            });
        };

        // Gestionnaire d'erreurs répliquant la logique mssql-plus[cite: 31]
        node.processError = function (err, msg, done) {
            let errMsg = err.message || err.toString();
            node.status({ fill: 'red', shape: 'ring', text: errMsg });
            
            if (node.throwErrors) {
                done(err); // Déclenche un nœud Catch
            } else {
                msg.error = {
                    message: errMsg,
                    originalError: err
                };
                node.send(msg); // Continue le flux avec l'erreur dans le payload
                done();
            }
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
                if (node.querySourceType === 'editor') {
                    rawQuery = node.query;
                } else {
                    rawQuery = await node.getEvaluatedProperty(node.querySource, node.querySourceType, msg);
                }

                // Fallback de compatibilité absolue
                if (!rawQuery && typeof msg.payload === 'string') rawQuery = msg.payload;

                if (!rawQuery) {
                    return node.processError(new Error("Requête SQL vide"), msg, done);
                }

                paramsVal = await node.getEvaluatedProperty(node.paramsSource, node.paramsSourceType, msg);

                // Évaluation Mustache robuste
                if (node.parseMustache && rawQuery.includes("{{")) {
                    const flowCtx = {};
                    node.context().flow.keys().forEach(k => { flowCtx[k] = node.context().flow.get(k); });
                    const globalCtx = {};
                    node.context().global.keys().forEach(k => { globalCtx[k] = node.context().global.get(k); });

                    const view = Object.assign({}, msg, {
                        msg: msg,
                        flow: flowCtx,
                        global: globalCtx
                    });
                    rawQuery = Mustache.render(rawQuery, view);
                }

            } catch (evalErr) {
                return node.processError(evalErr, msg, done);
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
                            
                            // Logique ReturnType de mssql-plus[cite: 31]
                            let finalPayload = rowsData;
                            if (node.returnType === 1) {
                                finalPayload = { recordset: rowsData, rowsAffected: [totalRows] };
                            }
                            
                            RED.util.setMessageProperty(msgToSend, node.outField, finalPayload);
                            msgToSend.mssql = { rowCount: totalRows, queryDurationMs: Date.now() - startTime };

                            node.status({ fill: "green", shape: "dot", text: `${totalRows} lignes (${msgToSend.mssql.queryDurationMs}ms)` });
                            send(msgToSend);
                        }
                        delete msg._mssql_attempt;
                        done();
                    } catch (postErr) {
                        return node.processError(postErr, msg, done);
                    }
                });

                function sendChunk(rowsChunk, isComplete) {
                    if (rowsChunk.length === 0 && !isComplete) return;

                    const msgChunk = RED.util.cloneMessage(msg);
                    let payloadData = (node.rowsPerMsg === 1 && rowsChunk.length === 1) ? rowsChunk[0] : rowsChunk;

                    // Adaptation ReturnType en mode split
                    if (node.returnType === 1) {
                        payloadData = { recordset: (Array.isArray(payloadData) ? payloadData : [payloadData]) };
                    }

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
                                // Détection du format classique mssql-plus : [{name: "Limit", type: "Int", value: 50}]
                                if (val && typeof val === 'object' && val.hasOwnProperty('name') && val.hasOwnProperty('value')) {
                                    let tediousType = val.type ? TYPES[val.type] : inferTediousType(val.value);
                                    if (!tediousType) tediousType = inferTediousType(val.value); // Fallback si le type est inconnu
                                    
                                    // Retrait de l'éventuel '@' au cas où il serait inclus dans le nom
                                    const cleanName = val.name.replace(/^@/, '');
                                    request.addParameter(cleanName, tediousType, val.value);
                                } 
                                // Format tableau simple : [50, "11KT0"] -> @p0, @p1
                                else {
                                    request.addParameter(`p${idx}`, inferTediousType(val), val);
                                }
                            });
                        } else {
                            // Format objet clé-valeur : {"Limit": 50, "SerialNum": "11KT0"}
                            for (const [pName, pVal] of Object.entries(paramsVal)) {
                                const cleanName = pName.replace(/^@/, '');
                                request.addParameter(cleanName, inferTediousType(pVal), pVal);
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
                            node.processError(e, msg, done);
                        });
                    }, delay);
                } else {
                    delete msg._mssql_attempt;
                    node.processError(err, msg, done);
                }
            }

            executeQueryWithRetry().catch(e => {
                node.processError(e, msg, done);
            });
        });
    }

    RED.nodes.registerType("mssqlmj-query", MSSQLMJQueryNode);
};