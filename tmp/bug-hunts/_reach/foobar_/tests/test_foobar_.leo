// The 'test_foobar_' test program.
import foobar_.aleo;
program test_foobar_.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = foobar_.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
