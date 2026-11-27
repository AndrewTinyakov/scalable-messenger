package com.andrewtinyakov.messenger.ws.grpc

import io.grpc.stub.StreamObserver

internal class RecordingObserver<T> : StreamObserver<T> {
    var value: T? = null
    var error: Throwable? = null

    override fun onNext(response: T) {
        value = response
    }

    override fun onError(error: Throwable) {
        this.error = error
    }

    override fun onCompleted() = Unit

    fun require(): T = value ?: throw AssertionError("gRPC call failed", error)
}
