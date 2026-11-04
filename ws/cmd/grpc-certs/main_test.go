package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"
)

func TestPrepareCreatesPurposeRestrictedCertificates(t *testing.T) {
	out := filepath.Join(t.TempDir(), "grpc")
	now := time.Now()
	if err := prepare(out, -1, now); err != nil {
		t.Fatal(err)
	}
	ca := readCertificate(t, out, "ca.pem")
	if !ca.IsCA || ca.KeyUsage != x509.KeyUsageCertSign|x509.KeyUsageCRLSign || !ca.MaxPathLenZero {
		t.Fatal("CA must only sign leaf certificates")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	api := readCertificate(t, out, "api-cert.pem")
	if !slices.Equal(api.DNSNames, []string{"api-grpc", "api-1-grpc", "api-2-grpc"}) {
		t.Fatalf("unexpected API DNS names: %v", api.DNSNames)
	}
	for _, name := range api.DNSNames {
		if _, err := api.Verify(x509.VerifyOptions{Roots: roots, DNSName: name, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			t.Fatal(err)
		}
	}
	ws := readCertificate(t, out, "ws-cert.pem")
	if len(ws.URIs) != 1 || ws.URIs[0].String() != "spiffe://messenger/ws" {
		t.Fatalf("unexpected WS URI identity: %v", ws.URIs)
	}
	if _, err := ws.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		cert    *x509.Certificate
		purpose x509.ExtKeyUsage
	}{{api, x509.ExtKeyUsageClientAuth}, {ws, x509.ExtKeyUsageServerAuth}} {
		if _, err := entry.cert.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{entry.purpose}}); err == nil {
			t.Fatal("certificate accepted for the opposite TLS purpose")
		}
	}
	for _, service := range []string{"api", "ws"} {
		if _, err := tls.LoadX509KeyPair(filepath.Join(out, service+"-cert.pem"), filepath.Join(out, service+"-key.pem")); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range materialNames {
		want := os.FileMode(0644)
		if name == "ca-key.pem" || name == "api-key.pem" || name == "ws-key.pem" {
			want = 0600
			block, _ := pem.Decode(readMaterial(t, out, name))
			if block == nil || block.Type != "PRIVATE KEY" {
				t.Fatalf("%s is not PKCS8 PEM", name)
			}
			if _, err := x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
				t.Fatal(err)
			}
		}
		info, err := os.Stat(filepath.Join(out, name))
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s permissions: got %v, error %v, want %04o", name, info, err, want)
		}
	}
}

func TestPreparePreservesExistingMaterial(t *testing.T) {
	out := t.TempDir()
	now := time.Now()
	if err := prepare(out, -1, now); err != nil {
		t.Fatal(err)
	}
	before := make(map[string][]byte)
	modified := make(map[string]time.Time)
	for _, name := range materialNames {
		before[name] = readMaterial(t, out, name)
		info, err := os.Stat(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		modified[name] = info.ModTime()
	}
	if err := prepare(out, -1, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, name := range materialNames {
		info, err := os.Stat(filepath.Join(out, name))
		if err != nil || !info.ModTime().Equal(modified[name]) || !bytes.Equal(before[name], readMaterial(t, out, name)) {
			t.Fatalf("existing %s was changed", name)
		}
	}
}

func TestPrepareSharesOnlyServiceKeysWithGroup(t *testing.T) {
	out := t.TempDir()
	gid := os.Getgid()
	if err := prepare(out, gid, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"api-key.pem", "ws-key.pem"} {
		info, err := os.Stat(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0640 || uint64(info.Sys().(*syscall.Stat_t).Gid) != uint64(gid) {
			t.Fatalf("%s must be readable only by its owner and service group", name)
		}
	}
	info, err := os.Stat(filepath.Join(out, "ca-key.pem"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("CA key must remain owner-only")
	}
	if err := prepare(out, gid, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareRejectsInvalidExistingMaterial(t *testing.T) {
	for _, scenario := range []string{"partial", "mismatched-key", "invalid-pem", "wrong-identity", "wrong-purpose", "expired", "insecure-key", "symlink"} {
		t.Run(scenario, func(t *testing.T) {
			out := t.TempDir()
			now := time.Now()
			if err := prepare(out, -1, now); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "partial":
				if err := os.Remove(filepath.Join(out, "ws-key.pem")); err != nil {
					t.Fatal(err)
				}
			case "mismatched-key":
				overwriteMaterial(t, out, "api-key.pem", readMaterial(t, out, "ws-key.pem"))
			case "invalid-pem":
				overwriteMaterial(t, out, "ca.pem", []byte("invalid certificate"))
			case "wrong-identity", "wrong-purpose":
				cert := readCertificate(t, out, "ws-cert.pem")
				if scenario == "wrong-identity" {
					cert.URIs[0].Path = "/other-service"
				} else {
					cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
				}
				ca := readCertificate(t, out, "ca.pem")
				block, _ := pem.Decode(readMaterial(t, out, "ca-key.pem"))
				key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
				if err != nil {
					t.Fatal(err)
				}
				der, err := x509.CreateCertificate(rand.Reader, cert, ca, cert.PublicKey, key.(*ecdsa.PrivateKey))
				if err != nil {
					t.Fatal(err)
				}
				overwriteMaterial(t, out, "ws-cert.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
			case "expired":
				now = now.Add(91 * 24 * time.Hour)
			case "insecure-key":
				if err := os.Chmod(filepath.Join(out, "ws-key.pem"), 0644); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(filepath.Join(out, "ws-key.pem")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("api-key.pem", filepath.Join(out, "ws-key.pem")); err != nil {
					t.Fatal(err)
				}
			}
			before := readMaterial(t, out, "api-cert.pem")
			if err := prepare(out, -1, now); err == nil {
				t.Fatal("invalid material was accepted")
			}
			if !bytes.Equal(before, readMaterial(t, out, "api-cert.pem")) {
				t.Fatal("invalid existing material was replaced")
			}
		})
	}
}

func readCertificate(t *testing.T, out, name string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(readMaterial(t, out, name))
	if block == nil {
		t.Fatal("missing PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

func readMaterial(t *testing.T, out, name string) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(out, name))
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func overwriteMaterial(t *testing.T, out, name string, content []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(out, name), content, 0600); err != nil {
		t.Fatal(err)
	}
}
