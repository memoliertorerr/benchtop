# hello — tests assert (BT63): print reaches USB serial; an exception's traceback does too, and
# the REPL comes back after it.
print("hello")
print(sum(range(10)))
raise ValueError("boom")
