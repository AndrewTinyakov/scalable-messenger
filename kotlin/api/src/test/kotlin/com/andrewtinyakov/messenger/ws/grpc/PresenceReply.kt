package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse
import io.grpc.stub.StreamObserver

internal class PresenceReply : StreamObserver<AuthorizePresenceResponse> {
    var value: AuthorizePresenceResponse? = null
    var error: Throwable? = null
    var completed = false

    override fun onNext(response: AuthorizePresenceResponse) {
        value = response
    }

    override fun onError(error: Throwable) {
        this.error = error
    }

    override fun onCompleted() {
        completed = true
    }
}
