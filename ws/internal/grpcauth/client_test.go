package grpcauth_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	authorization "messenger/ws/internal/generated/grpc"
	"messenger/ws/internal/grpcauth"
)

const testSessionExpiry = 2_000_000_000

type authorizationServer struct {
	authorization.UnimplementedChatAuthorizationServer
	t         *testing.T
	sessionID string
	revoked   bool
}

func (s *authorizationServer) validate(ctx context.Context, sessionID string) error {
	s.t.Helper()
	remote, ok := peer.FromContext(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "missing peer")
	}
	security, ok := remote.AuthInfo.(credentials.TLSInfo)
	if !ok || len(security.State.VerifiedChains) == 0 || len(security.State.PeerCertificates) == 0 {
		return status.Error(codes.Unauthenticated, "missing verified client certificate")
	}
	uris := security.State.PeerCertificates[0].URIs
	if len(uris) != 1 || uris[0].String() != "spiffe://messenger/ws" {
		return status.Error(codes.Unauthenticated, "wrong client identity")
	}
	if sessionID != s.sessionID {
		s.t.Errorf("RPC session ID = %q, want %q", sessionID, s.sessionID)
		return status.Error(codes.InvalidArgument, "wrong session")
	}
	if s.revoked {
		return status.Error(codes.Unauthenticated, "revoked session")
	}
	return nil
}

func (s *authorizationServer) ValidateSession(ctx context.Context, request *authorization.ValidateSessionRequest) (*authorization.ValidateSessionResponse, error) {
	if err := s.validate(ctx, request.GetSessionId()); err != nil {
		return nil, err
	}
	return &authorization.ValidateSessionResponse{UserId: "user", DeviceId: "device", SessionId: s.sessionID, ExpiresAtUnixSeconds: testSessionExpiry}, nil
}

func (s *authorizationServer) ValidateSessions(ctx context.Context, request *authorization.ValidateSessionsRequest) (*authorization.ValidateSessionsResponse, error) {
	if err := s.validate(ctx, request.GetSessionIds()[0]); err != nil {
		return nil, err
	}
	return &authorization.ValidateSessionsResponse{Sessions: []*authorization.ValidateSessionResponse{{UserId: "user", DeviceId: "device", SessionId: s.sessionID, ExpiresAtUnixSeconds: testSessionExpiry}}}, nil
}

func (s *authorizationServer) AuthorizeGroup(ctx context.Context, request *authorization.AuthorizeGroupRequest) (*authorization.AuthorizeGroupResponse, error) {
	if err := s.validate(ctx, request.GetSessionId()); err != nil {
		return nil, err
	}
	return &authorization.AuthorizeGroupResponse{Room: "group:" + request.GetChatId()}, nil
}

func (s *authorizationServer) AuthorizeGroups(ctx context.Context, request *authorization.AuthorizeGroupsRequest) (*authorization.AuthorizeGroupsResponse, error) {
	if err := s.validate(ctx, request.GetSessionId()); err != nil {
		return nil, err
	}
	return &authorization.AuthorizeGroupsResponse{AuthorizedChatIds: request.GetChatIds()}, nil
}

type certificateAuthority struct {
	certificate *x509.Certificate
	key         ed25519.PrivateKey
	pem         []byte
}

func newCA(t *testing.T) certificateAuthority {
	t.Helper()
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificateAuthority{certificate: certificate, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (ca certificateAuthority) issue(t *testing.T, client bool) ([]byte, []byte) {
	t.Helper()
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	if client {
		identity, err := url.Parse("spiffe://messenger/ws")
		if err != nil {
			t.Fatal(err)
		}
		template.URIs = []*url.URL{identity}
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	} else {
		template.DNSNames = []string{"api-grpc"}
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, public, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func writeMaterial(t *testing.T, directory, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func startAuthorizationServer(t *testing.T, ca certificateAuthority, service *authorizationServer) (string, grpcauth.TLSConfig) {
	t.Helper()
	certificate, key := ca.issue(t, false)
	serverCertificate, err := tls.X509KeyPair(certificate, key)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca.pem)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{serverCertificate}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert})))
	authorization.RegisterChatAuthorizationServer(server, service)
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	t.Cleanup(func() { server.Stop(); <-done })
	directory := t.TempDir()
	certificate, key = ca.issue(t, true)
	config := grpcauth.TLSConfig{CAFile: writeMaterial(t, directory, "ca.pem", ca.pem), CertFile: writeMaterial(t, directory, "ws-cert.pem", certificate), KeyFile: writeMaterial(t, directory, "ws-key.pem", key), ServerName: "api-grpc"}
	return listener.Addr().String(), config
}

func TestClientUsesMutualTLSAndSessionIDs(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "revoked"}[revoked], func(t *testing.T) {
			service := &authorizationServer{t: t, sessionID: strings.Repeat("a", 64), revoked: revoked}
			address, config := startAuthorizationServer(t, newCA(t), service)
			client, err := grpcauth.New(address, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = client.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			session, sessionErr := client.ValidateSession(ctx, service.sessionID)
			room, groupErr := client.AuthorizeGroup(ctx, service.sessionID, "chat")
			allowed, batchErr := client.AuthorizeGroups(ctx, service.sessionID, []string{"chat", "other"})
			live, liveErr := client.ValidateSessions(ctx, []string{service.sessionID})
			want := grpcauth.Session{UserID: "user", DeviceID: "device", SessionID: service.sessionID, ExpiresAt: time.Unix(testSessionExpiry, 0)}
			if revoked {
				if liveErr == nil || errors.Is(liveErr, grpcauth.ErrUnauthorized) {
					t.Errorf("failed batch validation error = %v, want a dependency error", liveErr)
				}
				for _, err := range []error{sessionErr, groupErr, batchErr} {
					if !errors.Is(err, grpcauth.ErrUnauthorized) {
						t.Errorf("revoked authorization error = %v", err)
					}
				}
			} else if sessionErr != nil || groupErr != nil || batchErr != nil || liveErr != nil || session != want || !reflect.DeepEqual(live, map[string]grpcauth.Session{service.sessionID: want}) || room != "group:chat" || !reflect.DeepEqual(allowed, map[string]bool{"chat": true, "other": true}) {
				t.Fatalf("mutual TLS RPCs: session=%+v/%v room=%q/%v allowed=%v/%v", session, sessionErr, room, groupErr, allowed, batchErr)
			}
		})
	}
}

func TestClientRejectsUntrustedServerAndWrongName(t *testing.T) {
	for _, kind := range []string{"untrusted CA", "wrong server name", "untrusted client"} {
		t.Run(kind, func(t *testing.T) {
			service := &authorizationServer{t: t, sessionID: strings.Repeat("a", 64)}
			address, config := startAuthorizationServer(t, newCA(t), service)
			switch kind {
			case "untrusted CA":
				config.CAFile = writeMaterial(t, t.TempDir(), "other-ca.pem", newCA(t).pem)
			case "wrong server name":
				config.ServerName = "other-api"
			case "untrusted client":
				certificate, key := newCA(t).issue(t, true)
				config.CertFile = writeMaterial(t, t.TempDir(), "other-cert.pem", certificate)
				config.KeyFile = writeMaterial(t, t.TempDir(), "other-key.pem", key)
			}
			client, err := grpcauth.New(address, config)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if _, err := client.ValidateSession(ctx, service.sessionID); err == nil {
				t.Fatal("TLS accepted untrusted identity")
			}
		})
	}
}

func TestNewRejectsMissingOrInvalidTLSMaterial(t *testing.T) {
	service := &authorizationServer{t: t, sessionID: strings.Repeat("a", 64)}
	address, valid := startAuthorizationServer(t, newCA(t), service)
	for _, kind := range []string{"missing CA", "invalid CA", "missing certificate", "invalid certificate", "missing key", "invalid key", "mismatched key", "missing name"} {
		t.Run(kind, func(t *testing.T) {
			config := valid
			invalid := writeMaterial(t, t.TempDir(), "invalid.pem", []byte("invalid"))
			switch kind {
			case "missing CA":
				config.CAFile = ""
			case "invalid CA":
				config.CAFile = invalid
			case "missing certificate":
				config.CertFile = ""
			case "invalid certificate":
				config.CertFile = invalid
			case "missing key":
				config.KeyFile = ""
			case "invalid key":
				config.KeyFile = invalid
			case "mismatched key":
				_, key := newCA(t).issue(t, true)
				config.KeyFile = writeMaterial(t, t.TempDir(), "other-key.pem", key)
			case "missing name":
				config.ServerName = ""
			}
			client, err := grpcauth.New(address, config)
			if err == nil {
				_ = client.Close()
				t.Fatal("accepted invalid TLS configuration")
			}
		})
	}
}
