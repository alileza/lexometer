package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// Minimal RFC 6455 WebSocket support, server-push only: we upgrade, send text
// frames, and read just enough from the client to answer pings and notice
// closes. Zero dependencies, which is all a localhost dashboard needs.

type wsHub struct {
	mu    sync.Mutex
	conns map[net.Conn]bool
}

func newWSHub() *wsHub { return &wsHub{conns: map[net.Conn]bool{}} }

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func (h *wsHub) Upgrade(w http.ResponseWriter, r *http.Request, onOpen func(net.Conn)) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	buf.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if err := buf.Flush(); err != nil {
		conn.Close()
		return
	}

	h.mu.Lock()
	h.conns[conn] = true
	h.mu.Unlock()
	if onOpen != nil {
		onOpen(conn)
	}
	go h.readLoop(conn, buf.Reader)
}

func (h *wsHub) drop(conn net.Conn) {
	h.mu.Lock()
	delete(h.conns, conn)
	h.mu.Unlock()
	conn.Close()
}

// readLoop consumes client frames: answers ping with pong, exits on close or
// error. Payload content from the client is discarded.
func (h *wsHub) readLoop(conn net.Conn, r *bufio.Reader) {
	defer h.drop(conn)
	for {
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(r, hdr); err != nil {
			return
		}
		opcode := hdr[0] & 0x0f
		masked := hdr[1]&0x80 != 0
		length := int64(hdr[1] & 0x7f)
		switch length {
		case 126:
			ext := make([]byte, 2)
			if _, err := io.ReadFull(r, ext); err != nil {
				return
			}
			length = int64(binary.BigEndian.Uint16(ext))
		case 127:
			ext := make([]byte, 8)
			if _, err := io.ReadFull(r, ext); err != nil {
				return
			}
			length = int64(binary.BigEndian.Uint64(ext))
		}
		if masked {
			if _, err := io.ReadFull(r, make([]byte, 4)); err != nil {
				return
			}
		}
		if length > 1<<20 { // dashboard clients have nothing this big to say
			return
		}
		if _, err := io.CopyN(io.Discard, r, length); err != nil {
			return
		}
		switch opcode {
		case 0x8: // close
			h.writeFrame(conn, 0x8, nil)
			return
		case 0x9: // ping -> pong (payload discarded; empty pong is acceptable here)
			if err := h.writeFrame(conn, 0xA, nil); err != nil {
				return
			}
		}
	}
}

func (h *wsHub) writeFrame(conn net.Conn, opcode byte, payload []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return writeFrameLocked(conn, opcode, payload)
}

func writeFrameLocked(conn net.Conn, opcode byte, payload []byte) error {
	n := len(payload)
	hdr := []byte{0x80 | opcode}
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n < 1<<16:
		hdr = append(hdr, 126, 0, 0)
		binary.BigEndian.PutUint16(hdr[2:], uint16(n))
	default:
		hdr = append(hdr, 127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(hdr[2:], uint64(n))
	}
	if _, err := conn.Write(hdr); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}

// Broadcast sends a text frame to every connected client, dropping the ones
// that error.
func (h *wsHub) Broadcast(payload []byte) {
	h.mu.Lock()
	var dead []net.Conn
	for conn := range h.conns {
		if err := writeFrameLocked(conn, 0x1, payload); err != nil {
			dead = append(dead, conn)
		}
	}
	for _, c := range dead {
		delete(h.conns, c)
	}
	h.mu.Unlock()
	for _, c := range dead {
		c.Close()
	}
}

// Send sends a text frame to one client (used for the on-connect snapshot).
func (h *wsHub) Send(conn net.Conn, payload []byte) {
	if err := h.writeFrame(conn, 0x1, payload); err != nil {
		h.drop(conn)
	}
}
