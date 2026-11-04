package rabbitmq

import (
	"context"
	"io"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
)

type brokerFaults struct {
	dropFirst atomic.Bool
	holdFirst atomic.Bool
	blockNew  atomic.Bool
	accepted  atomic.Int64
	dropped   chan struct{}
	resume    chan struct{}
}

func brokerProxy(t *testing.T, brokerURL string) (string, *brokerFaults) {
	t.Helper()
	target, err := url.Parse(brokerURL)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	faults := &brokerFaults{dropped: make(chan struct{}, 1), resume: make(chan struct{})}
	var owned sync.WaitGroup
	owned.Add(1)
	go func() {
		defer owned.Done()
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			first := faults.accepted.Add(1) == 1
			owned.Add(1)
			go func() {
				defer owned.Done()
				defer client.Close()
				stopClient := interruptTransport(ctx, client)
				defer stopClient()
				if faults.blockNew.Load() {
					<-ctx.Done()
					return
				}
				upstream, err := (&net.Dialer{}).DialContext(ctx, "tcp", target.Host)
				if err != nil {
					return
				}
				defer upstream.Close()
				stopUpstream := interruptTransport(ctx, upstream)
				defer stopUpstream()
				copied := make(chan struct{})
				go func() {
					defer close(copied)
					_, _ = io.Copy(upstream, client)
					_ = upstream.Close()
				}()
				buffer := make([]byte, 32768)
				for {
					count, err := upstream.Read(buffer)
					if count > 0 && first && faults.holdFirst.Load() {
						select {
						case faults.dropped <- struct{}{}:
						default:
						}
						select {
						case <-faults.resume:
						case <-ctx.Done():
							_ = upstream.Close()
							_ = client.Close()
							<-copied
							return
						}
					}
					if count > 0 && first && faults.dropFirst.Load() {
						select {
						case faults.dropped <- struct{}{}:
						default:
						}
					} else if count > 0 {
						if _, err := client.Write(buffer[:count]); err != nil {
							break
						}
					}
					if err != nil {
						break
					}
				}
				_ = client.Close()
				_ = upstream.Close()
				<-copied
			}()
		}
	}()
	t.Cleanup(func() { cancel(); _ = listener.Close(); owned.Wait() })
	proxyURL := *target
	proxyURL.Host = listener.Addr().String()
	return proxyURL.String(), faults
}
