'use strict';
/**
 * [GIT_IDS_0_10_25] git object ids of the files this engine loads, computed the way git computes them.
 * blob id = SHA-1("blob <size>\0" + bytes); tree id = SHA-1("tree <size>\0" + entries), each entry
 * "<mode> <name>\0" + 20-byte id, sorted by name (a folder sorts as "name/").
 * The engine computes them from the files it loaded, so anyone (or an AI that can only open web pages)
 * can compare two strings with GitHub: https://api.github.com/repos/<repo>/git/trees/<commit> lists the
 * same ids for `src` and `package.json`. A tree id covers every file name and every byte below it.
 * Every file in src/ is a plain file (mode 100644); a folder is mode 40000.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha1 = (head, body) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(head), body])).digest('hex');

function blobId(bytes) {
    return sha1(`blob ${bytes.length}\0`, bytes);
}

function treeId(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((f) => {
        const p = path.join(dir, f.name);
        return f.isDirectory()
            ? { name: f.name, key: f.name + '/', mode: '40000', id: treeId(p) }
            : { name: f.name, key: f.name, mode: '100644', id: blobId(fs.readFileSync(p)) };
    });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, 'hex')])));
    return sha1(`tree ${body.length}\0`, body);
}

module.exports = { blobId, treeId };
