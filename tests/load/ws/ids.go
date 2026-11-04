package main

import (
	"crypto/rand"
	"math/big"
	"time"
)

func ulid() string {
	var data [16]byte
	millis := uint64(time.Now().UnixMilli())
	for index := 5; index >= 0; index-- {
		data[index] = byte(millis)
		millis >>= 8
	}
	if _, err := rand.Read(data[6:]); err != nil {
		panic(err)
	}
	value, mask := new(big.Int).SetBytes(data[:]), big.NewInt(31)
	var result [26]byte
	for index := 25; index >= 0; index-- {
		result[index] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[new(big.Int).And(value, mask).Int64()]
		value.Rsh(value, 5)
	}
	return string(result[:])
}
