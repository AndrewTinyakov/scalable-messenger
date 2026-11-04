package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"time"
)

var materialNames = []string{"ca.pem", "ca-key.pem", "api-cert.pem", "api-key.pem", "ws-cert.pem", "ws-key.pem"}
var serverNames = []string{"api-grpc", "api-1-grpc", "api-2-grpc"}

const clientIdentity = "spiffe://messenger/ws"

func main() {
	out := flag.String("out", "../.local/grpc", "local development certificate directory")
	group := flag.String("service-key-group", "", "numeric supplementary group allowed to read service keys with mode 0640")
	flag.Parse()
	gid := -1
	if *group != "" {
		parsed, err := strconv.Atoi(*group)
		if err != nil || parsed < 0 {
			fmt.Fprintln(os.Stderr, "service-key-group must be a nonnegative numeric group ID")
			os.Exit(1)
		}
		gid = parsed
	}
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected positional arguments")
		os.Exit(1)
	}
	if err := prepare(*out, gid, time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Local development gRPC certificates ready in %s\n", *out)
}

func prepare(out string, gid int, now time.Time) error {
	info, err := os.Lstat(out)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !info.IsDir() {
		return fmt.Errorf("certificate directory must be a real directory: %s", out)
	}
	present := 0
	for _, name := range materialNames {
		if _, err := os.Lstat(filepath.Join(out, name)); err == nil {
			present++
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if present != 0 && present != len(materialNames) {
		return errors.New("partial certificate material; intentionally remove the complete local certificate directory to renew it")
	}
	if present == len(materialNames) {
		return validate(out, gid, now)
	}
	material, err := generate(now)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		return err
	}
	for _, name := range materialNames {
		file, err := os.OpenFile(filepath.Join(out, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if err := writeMaterial(file, material[name], name, gid); err != nil {
			return err
		}
	}
	return validate(out, gid, now)
}

func writeMaterial(file *os.File, content []byte, name string, gid int) error {
	defer file.Close()
	if _, err := file.Write(content); err != nil {
		return err
	}
	if gid >= 0 && (name == "api-key.pem" || name == "ws-key.pem") {
		if err := file.Chown(-1, gid); err != nil {
			return fmt.Errorf("assign service key group: %w", err)
		}
	}
	if err := file.Chmod(materialMode(name, gid)); err != nil {
		return err
	}
	return file.Sync()
}

func materialMode(name string, gid int) os.FileMode {
	if name == "ca-key.pem" {
		return 0600
	}
	if name == "api-key.pem" || name == "ws-key.pem" {
		if gid >= 0 {
			return 0640
		}
		return 0600
	}
	return 0644
}

func generate(now time.Time) (map[string][]byte, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	ca, err := certificateTemplate("Messenger local development CA", now, 5*365*24*time.Hour)
	if err != nil {
		return nil, err
	}
	ca.IsCA = true
	ca.BasicConstraintsValid = true
	ca.MaxPathLenZero = true
	ca.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	material := make(map[string][]byte)
	material["ca.pem"] = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	material["ca-key.pem"], err = encodeKey(caKey)
	if err != nil {
		return nil, err
	}
	for _, service := range []string{"api", "ws"} {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		cert, err := certificateTemplate("Messenger local development "+service, now, 90*24*time.Hour)
		if err != nil {
			return nil, err
		}
		cert.BasicConstraintsValid = true
		cert.KeyUsage = x509.KeyUsageDigitalSignature
		if service == "api" {
			cert.DNSNames = serverNames
			cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		} else {
			identity, err := url.Parse(clientIdentity)
			if err != nil {
				return nil, err
			}
			cert.URIs = []*url.URL{identity}
			cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		}
		der, err := x509.CreateCertificate(rand.Reader, cert, ca, &key.PublicKey, caKey)
		if err != nil {
			return nil, err
		}
		material[service+"-cert.pem"] = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		material[service+"-key.pem"], err = encodeKey(key)
		if err != nil {
			return nil, err
		}
	}
	return material, nil
}

func certificateTemplate(name string, now time.Time, lifetime time.Duration) (*x509.Certificate, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, err
	}
	return &x509.Certificate{
		SerialNumber: serial.Add(serial, big.NewInt(1)),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(lifetime),
	}, nil
}

func encodeKey(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func validate(out string, gid int, now time.Time) error {
	material := make(map[string][]byte)
	for _, name := range materialNames {
		path := filepath.Join(out, name)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm() != materialMode(name, gid) {
			return fmt.Errorf("%s must be a regular file with mode %04o", name, materialMode(name, gid))
		}
		if gid >= 0 && (name == "api-key.pem" || name == "ws-key.pem") {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || uint64(stat.Gid) != uint64(gid) {
				return fmt.Errorf("%s must belong to service key group %d", name, gid)
			}
		}
		material[name], err = os.ReadFile(path)
		if err != nil {
			return err
		}
		if name == "ca-key.pem" || name == "api-key.pem" || name == "ws-key.pem" {
			block, rest := pem.Decode(material[name])
			if block == nil || block.Type != "PRIVATE KEY" || len(bytes.TrimSpace(rest)) != 0 {
				return fmt.Errorf("%s must contain one PKCS8 PEM private key", name)
			}
			if _, err := x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	}
	ca, err := parseCertificate(material["ca.pem"])
	if err != nil {
		return fmt.Errorf("ca.pem: %w", err)
	}
	if !ca.IsCA || !ca.BasicConstraintsValid || !ca.MaxPathLenZero || ca.KeyUsage != x509.KeyUsageCertSign|x509.KeyUsageCRLSign || len(ca.ExtKeyUsage) != 0 {
		return errors.New("ca.pem must be a purpose-restricted local CA")
	}
	if err := ca.CheckSignatureFrom(ca); err != nil {
		return fmt.Errorf("ca.pem must be self-signed: %w", err)
	}
	if _, err := tls.X509KeyPair(material["ca.pem"], material["ca-key.pem"]); err != nil {
		return fmt.Errorf("CA key mismatch: %w", err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	if _, err := ca.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now}); err != nil {
		return fmt.Errorf("invalid local CA: %w", err)
	}
	for _, service := range []string{"api", "ws"} {
		cert, err := parseCertificate(material[service+"-cert.pem"])
		if err != nil {
			return fmt.Errorf("%s certificate: %w", service, err)
		}
		if _, err := tls.X509KeyPair(material[service+"-cert.pem"], material[service+"-key.pem"]); err != nil {
			return fmt.Errorf("%s key mismatch: %w", service, err)
		}
		purpose := x509.ExtKeyUsageClientAuth
		if service == "api" {
			purpose = x509.ExtKeyUsageServerAuth
			if !slices.Equal(cert.DNSNames, serverNames) || len(cert.URIs) != 0 {
				return errors.New("API certificate has unexpected server identities")
			}
		} else if len(cert.URIs) != 1 || cert.URIs[0].String() != clientIdentity || len(cert.DNSNames) != 0 {
			return errors.New("WS certificate has unexpected client identities")
		}
		if cert.IsCA || cert.KeyUsage != x509.KeyUsageDigitalSignature || !slices.Equal(cert.ExtKeyUsage, []x509.ExtKeyUsage{purpose}) || len(cert.UnknownExtKeyUsage) != 0 || len(cert.IPAddresses) != 0 || len(cert.EmailAddresses) != 0 {
			return fmt.Errorf("%s certificate has unexpected purposes or identities", service)
		}
		if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{purpose}}); err != nil {
			return fmt.Errorf("invalid %s certificate: %w", service, err)
		}
	}
	return nil
}

func parseCertificate(content []byte) (*x509.Certificate, error) {
	block, rest := pem.Decode(content)
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("expected one PEM certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}
